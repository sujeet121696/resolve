// Chat channel (Step 8) — the same brain over a text pipe, and the live-demo
// fallback if voice dies on stage.
//
// A deterministic state machine drives the conversation (email → confirm case
// → OTP → confirm action → resolve). No LLM sits between the customer and the
// flow — the LLM work (propose/judge) happens inside resolveCase exactly as it
// does for voice. Session state is server-side keyed by session id; the
// conversation id namespace is "chat-<session>" so OTP verification and case
// context isolate per chat session, same guarantees as a call.

import { getContextFor, lookupContext } from "./case-context.js";
import { attemptsLeft, attemptsPhrase, isVerified, sendOtp, verifyOtp } from "./otp.js";
import { resolveCase } from "./resolve-case.js";
import { emitEvent } from "./events.js";

type ChatState = "await_email" | "await_case_confirm" | "await_otp" | "await_action_confirm" | "done" | "locked";

const sessions = new Map<string, ChatState>();

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const CODE_RE = /\b(\d{6})\b/;
const YES_RE = /^(y|yes|yeah|yep|haan|ha|ok|okay|sure|please|confirm)/i;

function convId(sessionId: string): string {
  return `chat-${sessionId}`;
}

/** One turn of the chat: customer text in, agent reply out. */
export async function handleChatMessage(sessionId: string, text: string): Promise<string> {
  const state = sessions.get(sessionId) ?? "await_email";
  const message = text.trim();

  if (state === "locked") {
    return "This session is locked after too many wrong codes. Please contact support another way.";
  }
  if (state === "done") {
    return "This request is complete. Start a new chat if you need anything else.";
  }

  if (state === "await_email") {
    const email = message.match(EMAIL_RE)?.[0];
    if (!email) {
      sessions.set(sessionId, "await_email");
      return "Hi! I'm Resolve. I can help with refunds and order issues. What's the email address on your account?";
    }
    const ctx = await lookupContext(convId(sessionId), email);
    if (!ctx.found) return `I couldn't find any open tickets for ${email}. Could you double-check the address?`;
    sessions.set(sessionId, "await_case_confirm");
    return `${ctx.message} Is this what you're contacting us about? (yes/no)`;
  }

  if (state === "await_case_confirm") {
    if (!YES_RE.test(message)) {
      sessions.set(sessionId, "await_email");
      return "No problem — what's the email address on the account I should look at?";
    }
    const ctx = getContextFor(convId(sessionId));
    if (!ctx) {
      sessions.set(sessionId, "await_email");
      return "I lost the case context — what's the email address again?";
    }
    await sendOtp(convId(sessionId), ctx.email);
    sessions.set(sessionId, "await_otp");
    return `To verify it's you, I've sent a 6-digit code to ${ctx.email}. Please type it here.`;
  }

  if (state === "await_otp") {
    const code = message.match(CODE_RE)?.[1];
    if (!code) return "Please type the 6-digit code from the email.";
    const result = verifyOtp(convId(sessionId), code);
    if (result === "verified") {
      sessions.set(sessionId, "await_action_confirm");
      return "You're verified. Shall I go ahead and process the resolution for this ticket? (yes/no)";
    }
    if (result === "locked") {
      sessions.set(sessionId, "locked");
      return "Too many wrong codes — this session is now locked. Please contact support another way.";
    }
    if (result === "expired") {
      const ctx = getContextFor(convId(sessionId));
      if (ctx) await sendOtp(convId(sessionId), ctx.email);
      return "That code expired — I've sent a fresh one. Please type the new 6 digits.";
    }
    return `That code is incorrect. ${attemptsPhrase(attemptsLeft(convId(sessionId)))} — please check the email and try again.`;
  }

  // await_action_confirm
  if (!YES_RE.test(message)) {
    return "Okay, I won't take any action. Say 'yes' whenever you want me to proceed.";
  }
  const ctx = getContextFor(convId(sessionId));
  if (!ctx) {
    sessions.set(sessionId, "await_email");
    return "I lost the case context — what's the email address again?";
  }
  emitEvent("chat.resolve", `Chat session ${sessionId} → resolve_case on ticket ${ctx.facts.ticket_id}`);
  const result = await resolveCase(
    ctx.facts,
    { verified: isVerified(convId(sessionId)) },
    { notify_email: ctx.email, amount_narrated: ctx.amount_narrated },
  );
  // A held refund is not a finished case: the customer comes back once the
  // parcel is scanned in, so this session stays able to confirm. Verification
  // and case context persist, and requestReturn won't raise a second RMA.
  sessions.set(sessionId, result.outcome === "return_requested" ? "await_action_confirm" : "done");
  // Mirrors the voice tool's outcome → spoken-message map in server.ts.
  const messages: Record<string, string> = {
    resolved: `Done! Refund approved and processed — ${ctx.amount_narrated} will return to your original payment method in 5 to 7 business days. Reference: ${result.refund?.refund_id ?? ""}.`,
    denied: "This request can't be approved automatically. I've escalated it to a human specialist with the full case briefing — the ticket is marked urgent and you'll hear back soon.",
    return_requested: result.return_request?.message ?? result.note,
    already_resolved: "This order was already refunded earlier — no second refund was made. The original refund stands.",
    in_flight_blocked: "A previous attempt on this order is still being reviewed. A specialist will follow up.",
    unsupported: "This type of request needs a human specialist. The ticket has been escalated.",
  };
  return messages[result.outcome] ?? result.note;
}
