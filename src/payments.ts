// The payments seam — same idea as brain.ts, for money movement.
//
// The agents never import a payment SDK directly; they go through this
// interface, so the provider is swappable via the PAYMENTS env var:
//   PAYMENTS=dodo   → Dodo Payments, test mode (the default and the demo path)
//
// Adding a provider (Stripe, Razorpay, an internal ledger) means writing one
// module that satisfies PaymentProvider and adding a line to getPayments() —
// no agent, guard, or escalation code changes. That's the point of the seam:
// the vendors are defaults, not dependencies.
//
// Note: seed.ts / seed-repeat.ts deliberately keep using the Dodo SDK
// directly. Seeding demo products and checkout links is inherently
// vendor-specific, so abstracting it would add indirection with no payoff.
// Only the runtime path needs to be provider-neutral.

import { dodoPayments } from "./integrations/dodo.js";

/** Provider-neutral refund outcome — what the ops view and ticket notes show. */
export interface RefundResult {
  refund_id: string;
  status: "succeeded" | "failed" | "pending" | "review";
  payment_id: string;
  amount?: number; // minor units
  currency?: string;
  is_partial: boolean;
}

export interface PaymentProvider {
  /** Which implementation is live — shown on the ops view. */
  name: "dodo";
  /**
   * Refund a payment. Full refund when `amount` is omitted; partial refunds
   * are applied against the payment's first line item.
   */
  createRefund(
    paymentId: string,
    opts?: { amount?: number; reason?: string },
  ): Promise<RefundResult>;
}

export function getPayments(): PaymentProvider {
  const choice = (process.env.PAYMENTS ?? "dodo").toLowerCase();
  if (choice !== "dodo") {
    console.warn(`Unknown PAYMENTS="${choice}" — falling back to dodo`);
  }
  return dodoPayments;
}
