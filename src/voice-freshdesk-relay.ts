// ElevenLabs "Custom LLM" bridge (OpenAI chat-completions compatible) that
// hands the actual conversation reasoning to the real Freshdesk AI Agent
// Studio bot instead of our own brain — see integrations/freshdesk-webchat.ts
// for the mechanism. ElevenLabs still owns STT/TTS/telephony/turn-taking;
// only "what to say" comes from Freshdesk's bot (which in turn calls the same
// /tools/* endpoints as everything else — identical OTP/refund/guard logic).
//
// ElevenLabs' custom-LLM connector gives up well before Freshdesk's bot
// typically replies, so each request only waits a couple seconds; if the
// answer isn't ready yet we speak a short stall line that asks the caller
// to repeat themselves, which reliably produces a next turn to poll on
// (ElevenLabs does NOT reliably re-invoke us on its own during silence —
// confirmed live: a caller staying silent 10-15s+ got nothing further).
//
// Demo-scale simplification: ONE active call at a time, tracked as simple
// module-level state (a new Freshdesk visitor session starts when there's no
// session yet or the previous one went quiet for a while; otherwise later
// turns reuse it). Not safe for concurrent callers — fine for a single-caller
// demo, not production. See resolve-freshdesk-ai-agent-setup memory for context.

import express from "express";
import { emitEvent } from "./events.js";
import {
  createVisitor,
  sendVisitorMessage,
  waitForBotReply,
  webchatConfigured,
  type WebchatVisitor,
} from "./integrations/freshdesk-webchat.js";

const RELAY_TOKEN = process.env.TOOLS_TOKEN;

interface ChatMessage {
  role: string;
  content: string;
}

interface RelaySession {
  visitor: WebchatVisitor;
  ticketId: number;
  lastNoteId: number;
  lastActivityAt: number;
  waitingForReply: boolean;
}

// ElevenLabs doesn't reliably resend full message history per turn, so turn
// count can't tell a new call from a continuing one — a call gap is a much
// more reliable signal than message count.
const SESSION_STALE_MS = 90_000;

// How long a single request will wait for Freshdesk before giving up and
// stalling — must stay comfortably under ElevenLabs' own connector timeout.
// 3s caused a live custom_llm_error timeout on a slower turn (OTP verify) —
// back to the 2s value that held up across every other turn tested.
const REPLY_POLL_TIMEOUT_MS = 2_000;
const REPLY_POLL_INTERVAL_MS = 500;
// Both stall lines end with a direct question — ElevenLabs doesn't reliably
// re-invoke us on its own while the caller stays silent, so the next turn
// (and the poll that comes with it) only happens if the caller keeps
// talking. Ending with a question makes that happen immediately instead of
// leaving the caller waiting on a timer that may not exist.
const STALL_FIRST = "One moment, I'm pulling that up — can you say that again for me?";
const STALL_AGAIN = "Still just a second — go ahead and repeat that once more.";

let session: RelaySession | undefined;

export const voiceFreshdeskRelay = express.Router();

voiceFreshdeskRelay.use((req, res, next) => {
  if (!RELAY_TOKEN) return res.status(503).json({ error: "TOOLS_TOKEN not configured" });
  if (req.get("x-resolve-token") !== RELAY_TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
});

// The only route ElevenLabs' Custom LLM setting needs: an OpenAI Chat
// Completions-shaped endpoint that always responds as SSE (required even
// though our "streaming" is really one chunk — the bot's answer only exists
// once polling finds it, there's no true token stream to relay).
voiceFreshdeskRelay.post("/v1/chat/completions", async (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();

  const finish = (text: string) => {
    res.write(
      `data: ${JSON.stringify({
        id: "chatcmpl-freshdesk-relay",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "freshdesk-ai-agent",
        choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: "stop" }],
      })}\n\n`,
    );
    res.write("data: [DONE]\n\n");
    res.end();
  };

  if (!webchatConfigured()) {
    emitEvent("voice.freshdesk_relay.error", "Called with FRESHDESK_DOMAIN/WIDGET_ID/WIDGET_TOKEN/API_KEY missing");
    return finish("Sorry, support chat isn't configured right now. A specialist will follow up.");
  }

  const { messages = [] } = (req.body ?? {}) as { messages: ChatMessage[] };
  const userTurns = messages.filter((m) => m.role === "user");
  const latestRaw = userTurns.at(-1)?.content?.trim() ?? "";
  // ElevenLabs sends a literal "..." when the caller said nothing — never
  // forward that into the ticket as if it were real speech.
  const spokeSomething = latestRaw !== "" && latestRaw !== "...";

  try {
    const now = Date.now();
    const isNewCall = !session || now - session.lastActivityAt > SESSION_STALE_MS;
    if (isNewCall) {
      // Visitor-create + send already cost a few seconds on their own — skip
      // polling on this turn so the reply itself doesn't push us over
      // ElevenLabs' budget; the next turn picks up the bot's answer instead.
      const visitor = await createVisitor();
      const { ticketId, lastNoteId } = await sendVisitorMessage(visitor, latestRaw || "Hello");
      session = { visitor, ticketId, lastNoteId, lastActivityAt: now, waitingForReply: true };
      emitEvent("voice.freshdesk_relay.session_started", `New Freshdesk webchat ticket #${ticketId} for voice call`, {
        ticketId,
      });
      return finish(STALL_FIRST);
    }

    const active = session!;
    if (spokeSomething) {
      // Deliberately ignore the returned lastNoteId here — it reflects
      // everything visible right now, which can include a bot reply to the
      // PREVIOUS turn that we haven't spoken yet. Advancing the poll baseline
      // to it would silently skip that reply forever. The baseline only ever
      // moves forward when we actually deliver a reply, below.
      await sendVisitorMessage(active.visitor, latestRaw);
      active.waitingForReply = false;
    }
    active.lastActivityAt = now;

    const result = await waitForBotReply(active.ticketId, active.lastNoteId, REPLY_POLL_TIMEOUT_MS, REPLY_POLL_INTERVAL_MS);
    if (result) {
      active.lastNoteId = result.lastNoteId;
      active.waitingForReply = false;
      finish(result.text);
    } else {
      finish(active.waitingForReply ? STALL_AGAIN : STALL_FIRST);
      active.waitingForReply = true;
    }
  } catch (err) {
    emitEvent("voice.freshdesk_relay.error", (err as Error).message);
    finish("Sorry, something went wrong on our side. A specialist will follow up on your ticket.");
  }
});
