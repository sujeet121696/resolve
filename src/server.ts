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

// Client-safe config for the React app. The agent id is client-visible by
// design (it ships in the widget's HTML attribute) — expose nothing else here.
app.get("/app-config", (_req, res) => {
  res.json({ elevenLabsAgentId: process.env.ELEVENLABS_AGENT_ID ?? "" });
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
// ngrok. Guarded by a shared secret header so a leaked tunnel URL is inert.
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
  if (!conversation_id || !email) return res.status(400).json({ error: "conversation_id and email required" });
  try {
    res.json(await lookupContext(conversation_id, email));
  } catch (err) {
    res.status(500).json({ found: false, message: (err as Error).message });
  }
});

tools.post("/send-otp", async (req, res) => {
  const { conversation_id } = req.body ?? {};
  if (!conversation_id) return res.status(400).json({ error: "conversation_id required" });
  const ctx = getContextFor(conversation_id);
  if (!ctx) return res.json({ sent: false, message: "No case context yet - look up the customer first." });
  try {
    await sendOtp(conversation_id, ctx.email);
    res.json({ sent: true, message: `Verification code sent to ${ctx.email}.` });
  } catch (err) {
    res.status(500).json({ sent: false, message: (err as Error).message });
  }
});

tools.post("/verify-otp", (req, res) => {
  const { conversation_id, code } = req.body ?? {};
  if (!conversation_id || !code) return res.status(400).json({ error: "conversation_id and code required" });
  const result = verifyOtp(conversation_id, String(code));
  const messages: Record<string, string> = {
    verified: "Identity verified successfully.",
    wrong_code: `That code is incorrect. ${attemptsPhrase(attemptsLeft(conversation_id))}.`,
    locked: "Too many wrong codes - this call is locked. The caller must contact support another way.",
    expired: "The code expired. Send a fresh one.",
    no_otp: "No code was sent yet for this call.",
  };
  res.json({ result, message: messages[result] });
});

tools.post("/resolve-case", async (req, res) => {
  const { conversation_id } = req.body ?? {};
  if (!conversation_id) return res.status(400).json({ error: "conversation_id required" });
  const ctx = getContextFor(conversation_id);
  if (!ctx) return res.json({ outcome: "no_context", message: "No case context yet - look up the customer first." });
  try {
    const result = await resolveCase(
      ctx.facts,
      { verified: isVerified(conversation_id) },
      { notify_email: ctx.email, amount_narrated: ctx.amount_narrated },
    );
    const messages: Record<string, string> = {
      resolved: `Refund approved and processed. Amount ${ctx.amount_narrated} will return to the original payment method in 5 to 7 business days. Reference ${result.refund?.refund_id ?? ""}.`,
      denied: `This request cannot be approved automatically (${result.verdict?.hard_check_failed ?? "policy"}). It is being escalated to a human specialist who will follow up on the ticket.`,
      return_requested: result.return_request?.message ?? result.note,
      already_resolved: "This order was already refunded earlier - no second refund was made. The original refund stands.",
      in_flight_blocked: "A previous attempt on this order is still being reviewed. A specialist will follow up.",
      unsupported: "This type of request needs a human specialist. The ticket has been escalated.",
    };
    res.json({ outcome: result.outcome, message: messages[result.outcome] ?? result.note });
  } catch (err) {
    res.status(500).json({ outcome: "error", message: (err as Error).message });
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

// --- Chat channel (Step 8) — same brain, text pipe; the live-demo fallback.
// Customer-facing like the voice widget (no shared secret): identity is still
// gated by OTP, and the state machine lives server-side per session.
app.post("/chat", async (req, res) => {
  const { session_id, message = "" } = req.body ?? {};
  if (!session_id) return res.status(400).json({ error: "session_id required" });
  try {
    res.json({ reply: await handleChatMessage(String(session_id), String(message)) });
  } catch (err) {
    res.status(500).json({ reply: `Something went wrong on our side: ${(err as Error).message}` });
  }
});

// Dev helper: fire an event by hand to watch it land on the ops view.
app.post("/dev/test-event", (req, res) => {
  const { type = "dev.test", message = "Test event", data } = req.body ?? {};
  res.json(emitEvent(type, message, data));
});

app.listen(PORT, () => {
  emitEvent("server.started", `Resolve orchestrator listening on http://localhost:${PORT}`);
});
