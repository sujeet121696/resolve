// Outcome -> customer-facing wording, shared by the chat surface (chat.ts)
// and the ElevenLabs voice tool (server.ts).
//
// Split out after a real bug (Sept 15): both surfaces hardcoded "Refund
// approved..." for every "resolved" outcome, so a plan_change case came back
// worded as a refund with an empty reference number. `resolvedMessage`
// branches on which result field actually came back — never on the ticket's
// original claim_type — so a wrong guess here can't misdescribe what really
// happened. Pulled into its own module so this stays unit-testable without a
// live Dodo call.

import type { ResolveCaseResult } from "./resolve-case.js";

/** Chat surface: friendlier tone, em dashes. */
export function chatResolvedMessage(result: ResolveCaseResult, amountNarrated?: string): string {
  if (result.plan_change) {
    return `Done! Plan changed and confirmed — ${(result.plan_change.charged_amount / 100).toFixed(2)} ${result.plan_change.currency} charged today, subscription now on the new plan.`;
  }
  return `Done! Refund approved and processed — ${amountNarrated ?? ""} will return to your original payment method in 5 to 7 business days. Reference: ${result.refund?.refund_id ?? ""}.`;
}

/** Voice surface: plain ASCII, spoken by ElevenLabs — no em dashes/curly punctuation. */
export function voiceResolvedMessage(result: ResolveCaseResult, amountNarrated?: string): string {
  if (result.plan_change) {
    return `Plan change approved and processed. ${(result.plan_change.charged_amount / 100).toFixed(2)} ${result.plan_change.currency} charged today, and the subscription is now on the new plan.`;
  }
  return `Refund approved and processed. Amount ${amountNarrated ?? ""} will return to the original payment method in 5 to 7 business days. Reference ${result.refund?.refund_id ?? ""}.`;
}
