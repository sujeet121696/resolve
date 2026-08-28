// OTP beat (Step 5) — the identity gate before any money moves.
//
// Security shape (DESIGN.md):
//   - `verified` lives HERE, server-side, keyed by conversation ID — never in
//     the conversation/LLM memory, so it can't be talked into existence.
//   - 6-digit code, 5-minute expiry, TWO wrong attempts → locked. A locked
//     conversation stays locked; resolve_case refuses even with perfect facts.

import crypto from "node:crypto";
import { deliveryAddressFor, fromAddress, mailTransport, smtpConfigured } from "./mailer.js";
import { emitEvent } from "./events.js";

interface OtpEntry {
  code: string;
  email: string;
  expires_at: number;
  attempts_left: number;
  state: "pending" | "verified" | "locked";
}

const sessions = new Map<string, OtpEntry>(); // keyed by conversation_id

const OTP_TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 2;

/** Issue a code and email it. Re-issuing replaces the old code (fresh attempts). */
export async function sendOtp(conversationId: string, email: string): Promise<{ sent: boolean }> {
  const code = crypto.randomInt(100000, 1000000).toString();
  sessions.set(conversationId, {
    code,
    email,
    expires_at: Date.now() + OTP_TTL_MS,
    attempts_left: MAX_ATTEMPTS,
    state: "pending",
  });

  if (!smtpConfigured()) {
    // Dev fallback: no SMTP creds yet — surface the code on the ops view only.
    emitEvent("otp.sent", `[dev, SMTP unconfigured] OTP for ${email}: ${code}`, {
      conversation_id: conversationId,
    });
    return { sent: false };
  }

  // Demo redirect lives in mailer.ts so OTP and confirmation mail always agree.
  const deliverTo = deliveryAddressFor(email);

  await mailTransport().sendMail({
    from: fromAddress(),
    to: deliverTo,
    subject: `${code} is your Resolve verification code`,
    text: `Your Resolve verification code is ${code}. It expires in 5 minutes. If you didn't request this, ignore this email.`,
  });
  emitEvent(
    "otp.sent",
    deliverTo === email ? `OTP emailed to ${email}` : `OTP for ${email} redirected to ${deliverTo} (demo)`,
    { conversation_id: conversationId },
  );
  return { sent: true };
}

export type VerifyResult = "verified" | "wrong_code" | "locked" | "expired" | "no_otp";

export function verifyOtp(conversationId: string, code: string): VerifyResult {
  const entry = sessions.get(conversationId);
  if (!entry) return "no_otp";
  if (entry.state === "locked") return "locked";
  if (entry.state === "verified") return "verified";
  if (Date.now() > entry.expires_at) {
    emitEvent("otp.expired", `OTP expired for conversation ${conversationId}`);
    return "expired";
  }
  if (entry.code === code.trim()) {
    entry.state = "verified";
    emitEvent("otp.verified", `Caller verified (conversation ${conversationId})`);
    return "verified";
  }
  entry.attempts_left -= 1;
  if (entry.attempts_left <= 0) {
    entry.state = "locked";
    emitEvent("otp.locked", `${MAX_ATTEMPTS} wrong codes — conversation ${conversationId} LOCKED`, {
      conversation_id: conversationId,
    });
    return "locked";
  }
  emitEvent("otp.wrong", `Wrong code, ${entry.attempts_left} attempt${entry.attempts_left === 1 ? "" : "s"} left`, {
    conversation_id: conversationId,
  });
  return "wrong_code";
}

/** Code attempts still available on this conversation. 0 when locked or unknown. */
export function attemptsLeft(conversationId: string): number {
  return sessions.get(conversationId)?.attempts_left ?? 0;
}

/**
 * "One attempt remains" / "2 attempts remain" — sentence-initial, so both the
 * chat and voice replies can compose it. Lives here so the customer-facing copy
 * can never drift from MAX_ATTEMPTS the way a hardcoded "One" silently did.
 */
export function attemptsPhrase(remaining: number): string {
  return remaining === 1 ? "One attempt remains" : `${remaining} attempts remain`;
}

/** The flag resolve_case trusts. Only ever true via a correct code above. */
export function isVerified(conversationId: string): boolean {
  return sessions.get(conversationId)?.state === "verified";
}
