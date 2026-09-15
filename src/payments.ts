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

/** Provider-neutral plan-change outcome — same "trust the response, not the intent" rule as RefundResult. */
export interface PlanChangeResult {
  subscription_id: string;
  new_product_id: string;
  charged_amount: number; // minor units — what was actually billed (0 for a pure downgrade/schedule)
  currency: string;
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
  /**
   * The exact number the guard approves — never the intent. Mirrors
   * createRefund's contract: the caller trusts this response, not a guess.
   */
  previewPlanChange(
    subscriptionId: string,
    newProductId: string,
  ): Promise<{ amount: number; currency: string }>;
  /** Executes an already-guard-approved plan change. Charges the saved payment method directly. */
  changePlan(subscriptionId: string, newProductId: string): Promise<PlanChangeResult>;
}

export function getPayments(): PaymentProvider {
  const choice = (process.env.PAYMENTS ?? "dodo").toLowerCase();
  if (choice !== "dodo") {
    console.warn(`Unknown PAYMENTS="${choice}" — falling back to dodo`);
  }
  return dodoPayments;
}
