import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { emitEvent, recentEvents, subscribe } from "./events.js";
import { getBrain } from "./brain.js";
import { getContextFor, lookupContext } from "./case-context.js";
import { attemptsLeft, attemptsPhrase, isVerified, sendOtp, verifyOtp } from "./otp.js";
import { resolveCase } from "./resolve-case.js";
import { markReturnReceived } from "./returns.js";
import { handleChatMessage } from "./chat.js";
import { dashboardMetrics } from "./metrics.js";
import { voiceFreshdeskRelay } from "./voice-freshdesk-relay.js";
import { admin } from "./admin.js";
import { rehydrateFollowUps } from "./agents/escalation.js";
import { PROVIDER_ERROR_CHAT, PROVIDER_ERROR_VOICE, voiceResolvedMessage } from "./resolution-messages.js";
import type { CaseFacts } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);

const app = express();
app.use(express.json());

// --- React app (web/) — built with `npm run build:web`, served at /app.
const WEB_DIST = path.resolve(__dirname, "..", "web", "dist");
app.get("/", (_req, res) => res.redirect("/app/"));
app.use("/app", express.static(WEB_DIST));
app.get("/app/*", (_req, res) => {
  res.sendFile(path.join(WEB_DIST, "index.html"), (err) => {
    if (err) res.status(404).send("React build not found — run: npm run build:web");
  });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "resolve", ts: new Date().toISOString() });
});

// Client-safe config for the React app. Everything here is client-visible by
// design — the ElevenLabs agent id ships in the widget's HTML attribute, and the
// Freshdesk web-widget token/id are the public embed identifiers Freshdesk hands
// out for a page snippet. NEVER add an API key or the tools token here.
app.get("/app-config", (_req, res) => {
  const domain = process.env.FRESHDESK_DOMAIN;
  const token = process.env.FRESHDESK_WIDGET_TOKEN;
  const widgetId = process.env.FRESHDESK_WIDGET_ID;
  res.json({
    elevenLabsAgentId: process.env.ELEVENLABS_AGENT_ID ?? "",
    // Empty when not configured, so the UI degrades to the built-in chat.
    freshdeskWidget:
      domain && token && widgetId
        ? { host: `https://${domain}.freshdesk.com`, token, widgetId }
        : null,
  });
});

// Cost dashboard (Costs tab). Aggregates only — counts, minutes, tokens,
// dollars — never emails or payment ids, so it is safe on the public tunnel
// where the raw audit trail (audit-report.ts) deliberately is not.
app.get("/dashboard-metrics", async (req, res) => {
  try {
    res.json(await dashboardMetrics(req.query.period === "today" ? "today" : "all"));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// SSE stream: replay recent history, then push live events until the tab closes.
app.get("/events", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();

  const send = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  for (const event of recentEvents()) send(event);
  const unsubscribe = subscribe(send);

  const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 25_000);
  req.on("close", () => {
    clearInterval(keepAlive);
    unsubscribe();
  });
});

// Dev helper: run a decision cycle (propose → judge) through the active brain.
// Body = CaseFacts JSON. Doubles as the Step 3 latency harness on BRAIN=claude.
app.post("/dev/decide", async (req, res) => {
  const facts = req.body as CaseFacts;
  const brain = getBrain();
  try {
    const t0 = performance.now();
    const proposal = await brain.propose(facts);
    const t1 = performance.now();
    const verdict = await brain.judge(proposal);
    const t2 = performance.now();
    res.json({
      brain: brain.name,
      proposal,
      verdict,
      timing_ms: {
        propose: Math.round(t1 - t0),
        judge: Math.round(t2 - t1),
        total: Math.round(t2 - t0),
      },
    });
  } catch (err) {
    res.status(500).json({ brain: brain.name, error: (err as Error).message });
  }
});

// OTP beat (Step 5). These become the voice agent's verify tools in Step 6.
app.post("/otp/send", async (req, res) => {
  const { conversation_id, email } = req.body ?? {};
  if (!conversation_id || !email) return res.status(400).json({ error: "conversation_id and email required" });
  try {
    res.json(await sendOtp(conversation_id, email));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/otp/verify", (req, res) => {
  const { conversation_id, code } = req.body ?? {};
  if (!conversation_id || !code) return res.status(400).json({ error: "conversation_id and code required" });
  res.json({ result: verifyOtp(conversation_id, String(code)) });
});

// The full chain: facts → propose → guard → refund → note.
// Body: { facts, conversation_id? , verified? }. With conversation_id the
// verified flag comes from the OTP store (the real path); the explicit
// `verified` override remains for brain-only dev tests (defaults true).
app.post("/dev/resolve-case", async (req, res) => {
  const { facts, conversation_id, verified = true } = req.body as {
    facts: CaseFacts;
    conversation_id?: string;
    verified?: boolean;
  };
  try {
    const isCallerVerified = conversation_id ? isVerified(conversation_id) : verified;
    // Confirmation mail only when a real context exists — raw-facts dev calls
    // (injection tests, brain harness) have no customer and send nothing.
    const known = conversation_id ? getContextFor(conversation_id) : undefined;
    res.json(
      await resolveCase(
        facts,
        { verified: isCallerVerified },
        { notify_email: known?.email, amount_narrated: known?.amount_narrated },
      ),
    );
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// --- Voice tools (Step 6) — the endpoints the ElevenLabs agent calls through
// the public tunnel. Guarded by a shared secret header so a leaked tunnel URL is inert.
// The agent supplies conversation_id from its system__conversation_id dynamic
// variable; facts and the verified flag live server-side keyed by that id, so
// nothing said in the call can alter what gets refunded.
const TOOLS_TOKEN = process.env.TOOLS_TOKEN;
const tools = express.Router();

tools.use((req, res, next) => {
  if (!TOOLS_TOKEN) return res.status(503).json({ error: "TOOLS_TOKEN not configured" });
  if (req.get("x-resolve-token") !== TOOLS_TOKEN) {
    emitEvent("tools.unauthorized", `Rejected /tools call without valid token (${req.path})`);
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
});

tools.post("/get-context", async (req, res) => {
  const { conversation_id, email } = req.body ?? {};
  if (!conversation_id || !email) {
    emitEvent("tools.invalid_request", `get-context called without ${!conversation_id ? "conversation_id" : "email"}`);
    return res.status(400).json({ error: "conversation_id and email required" });
  }
  try {
    res.json(await lookupContext(conversation_id, email));
  } catch (err) {
    res.status(500).json({ found: false, message: (err as Error).message });
  }
});

// Combines get-context + send-otp into one call for the native voice agent's
// first step — two separate tool calls left a seam where the model would
// speak an interim line between them instead of one natural sentence.
// Freshdesk AI Agent Studio calls get-context/send-otp directly as its own
// separate API actions, unaffected by this — this is additive, not a replacement.
tools.post("/lookup-and-send-otp", async (req, res) => {
  const { conversation_id, email } = req.body ?? {};
  if (!conversation_id || !email) {
    emitEvent("tools.invalid_request", `lookup-and-send-otp called without ${!conversation_id ? "conversation_id" : "email"}`);
    return res.status(400).json({ error: "conversation_id and email required" });
  }
  let context;
  try {
    context = await lookupContext(conversation_id, email);
  } catch (err) {
    return res.status(500).json({ found: false, sent: false, message: (err as Error).message });
  }
  if (!context.found) return res.json({ ...context, sent: false });

  const ctx = getContextFor(conversation_id)!;
  try {
    const result = await sendOtp(conversation_id, ctx.email);
    if (result.blocked) {
      return res.json({
        ...context,
        sent: false,
        message:
          result.blocked === "locked"
            ? "This conversation is locked after too many wrong codes. No new code can be sent - the customer must contact support another way."
            : "The maximum number of codes has been sent for this conversation. No new code can be sent - the customer must contact support another way.",
      });
    }
    res.json({ ...context, sent: true, message: `${context.message} A verification code has been sent to ${ctx.email}.` });
  } catch (err) {
    res.status(500).json({ ...context, sent: false, message: (err as Error).message });
  }
});

tools.post("/send-otp", async (req, res) => {
  const { conversation_id } = req.body ?? {};
  if (!conversation_id) {
    emitEvent("tools.invalid_request", "send-otp called without conversation_id");
    return res.status(400).json({ error: "conversation_id required" });
  }
  const ctx = getContextFor(conversation_id);
  if (!ctx) {
    emitEvent("otp.no_context", `send-otp called for conversation ${conversation_id} before get-context ran`);
    return res.json({ sent: false, message: "No case context yet - look up the customer first." });
  }
  try {
    const result = await sendOtp(conversation_id, ctx.email);
    if (result.blocked) {
      return res.json({
        sent: false,
        message:
          result.blocked === "locked"
            ? "This conversation is locked after too many wrong codes. No new code can be sent - the customer must contact support another way."
            : "The maximum number of codes has been sent for this conversation. No new code can be sent - the customer must contact support another way.",
      });
    }
    res.json({ sent: true, message: `Verification code sent to ${ctx.email}.` });
  } catch (err) {
    res.status(500).json({ sent: false, message: (err as Error).message });
  }
});

tools.post("/verify-otp", (req, res) => {
  const { conversation_id, code } = req.body ?? {};
  if (!conversation_id || !code) {
    emitEvent("tools.invalid_request", "verify-otp called without conversation_id or code");
    return res.status(400).json({ error: "conversation_id and code required" });
  }
  const result = verifyOtp(conversation_id, String(code));
  const messages: Record<string, string> = {
    verified: "Identity verified successfully.",
    wrong_code: `That code is incorrect. ${attemptsPhrase(attemptsLeft(conversation_id))}.`,
    locked: "Too many wrong codes - this call is locked. The caller must contact support another way.",
    expired: "The code expired. Send a fresh one.",
    no_otp: "No code was sent yet for this call.",
  };
  emitEvent(`otp.${result}`, `Verify OTP for conversation ${conversation_id}: ${result}`);
  res.json({ result, message: messages[result] });
});

tools.post("/resolve-case", async (req, res) => {
  const { conversation_id } = req.body ?? {};
  if (!conversation_id) {
    emitEvent("tools.invalid_request", "resolve-case called without conversation_id");
    return res.status(400).json({ error: "conversation_id required" });
  }
  const ctx = getContextFor(conversation_id);
  if (!ctx) {
    emitEvent("resolve_case.no_context", `resolve-case called for conversation ${conversation_id} before get-context ran`);
    return res.json({ outcome: "no_context", message: "No case context yet - look up the customer first." });
  }
  try {
    const result = await resolveCase(
      ctx.facts,
      { verified: isVerified(conversation_id) },
      { notify_email: ctx.email, amount_narrated: ctx.amount_narrated },
    );
    const messages: Record<string, string> = {
      resolved: voiceResolvedMessage(result, ctx.amount_narrated),
      denied: `This request cannot be approved automatically (${result.verdict?.hard_check_failed ?? "policy"}). It is being escalated to a human specialist who will follow up on the ticket.`,
      return_requested: result.return_request?.message ?? result.note,
      already_resolved: "This order was already refunded earlier - no second refund was made. The original refund stands.",
      in_flight_blocked: "A previous attempt on this order is still being reviewed. A specialist will follow up.",
      unsupported: "This type of request needs a human specialist. The ticket has been escalated.",
      provider_error: PROVIDER_ERROR_VOICE,
    };
    res.json({ outcome: result.outcome, message: messages[result.outcome] ?? result.note });
  } catch (err) {
    // Detail to the audit log, a neutral line to the customer: an exception's
    // text can carry provider wording, ids or internal paths, and this reply is
    // read aloud or shown as-is.
    emitEvent("tools.error", `resolve-case threw for conversation ${conversation_id}: ${(err as Error).message}`);
    res.status(500).json({ outcome: "error", message: PROVIDER_ERROR_VOICE });
  }
});

// Warehouse hook — in production the WMS/3PL calls this when the parcel is
// scanned in. It sits behind the same shared secret as the voice tools because
// it is a system-to-system call: the customer must not be able to mark their
// own return as received, any more than they can set their own verified flag.
tools.post("/return-received", (req, res) => {
  const { order_id } = req.body ?? {};
  if (!order_id) return res.status(400).json({ error: "order_id required" });
  const record = markReturnReceived(String(order_id));
  if (!record) {
    return res.status(404).json({
      received: false,
      message: `No return has been arranged for ${order_id} — nothing to mark received.`,
    });
  }
  res.json({
    received: true,
    rma: record.rma,
    order_id: record.order_id,
    message: `Return ${record.rma} for ${record.order_id} marked received — the refund is now unblocked.`,
  });
});

app.use("/tools", tools);

// ElevenLabs "Custom LLM" bridge — voice's turn to talk to the real Freshdesk
// AI Agent Studio bot instead of our own brain directly. See
// voice-freshdesk-relay.ts for the mechanism and why it's demo-scale only.
app.use("/voice/freshdesk-relay", voiceFreshdeskRelay);

// Admin/demo-setup helpers (mint payment, create ticket) — see admin.ts.
app.use("/admin", admin);

// --- Chat channel (Step 8) — same brain, text pipe; the live-demo fallback.
// Customer-facing like the voice widget (no shared secret): identity is still
// gated by OTP, and the state machine lives server-side per session.
app.post("/chat", async (req, res) => {
  const { session_id, message = "" } = req.body ?? {};
  if (!session_id) return res.status(400).json({ error: "session_id required" });
  try {
    res.json({ reply: await handleChatMessage(String(session_id), String(message)) });
  } catch (err) {
    emitEvent("chat.error", `chat handler threw for session ${session_id}: ${(err as Error).message}`);
    res.status(500).json({ reply: PROVIDER_ERROR_CHAT });
  }
});

// Dev helper: fire an event by hand to watch it land on the ops view.
app.post("/dev/test-event", (req, res) => {
  const { type = "dev.test", message = "Test event", data } = req.body ?? {};
  res.json(emitEvent(type, message, data));
});

app.listen(PORT, () => {
  emitEvent("server.started", `Resolve orchestrator listening on http://localhost:${PORT}`);
  rehydrateFollowUps();
});
