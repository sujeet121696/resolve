// Dodo Payments wrapper (official Node SDK).
// Gotchas from SPIKES.md, applied here:
//   - DODO_PAYMENTS_ENVIRONMENT=test_mode is mandatory (SDK defaults to live → 401)
//   - keys have no "dodo_test_" prefix
//   - test-mode fees drain the wallet → seed several payments so full refunds clear
//   - test mode rejects INR → all seeded payments are USD, narration dual-labels ₹

import DodoPayments from "dodopayments";
// Type-only import: the shared contract lives in the payments seam, so there
// is no runtime cycle between seam and implementation.
import type { PaymentProvider, PlanChangeResult, RefundResult } from "../payments.js";

// Re-exported so existing importers of RefundResult keep working unchanged.
export type { RefundResult };

let client: DodoPayments | null = null;

export function dodoClient(): DodoPayments {
  if (!client) {
    // Safety latch for the whole hackathon build: never touch live mode.
    if (process.env.DODO_PAYMENTS_ENVIRONMENT !== "test_mode") {
      throw new Error(
        "DODO_PAYMENTS_ENVIRONMENT must be 'test_mode' — refusing to start against live Dodo.",
      );
    }
    client = new DodoPayments({
      bearerToken: process.env.DODO_PAYMENTS_API_KEY,
      environment: "test_mode",
    });
  }
  return client;
}

/**
 * Refund a payment. Full refund when `amount` is omitted; partial refunds are
 * applied against the payment's first line item (our seeded payments are all
 * single-item carts).
 */
export async function createRefund(
  paymentId: string,
  opts: { amount?: number; reason?: string } = {},
): Promise<RefundResult> {
  const dodo = dodoClient();

  let items: { item_id: string; amount?: number }[] | undefined;
  if (opts.amount !== undefined) {
    const lineItems = await dodo.payments.retrieveLineItems(paymentId);
    const first = lineItems.items[0];
    if (!first) throw new Error(`Payment ${paymentId} has no line items to refund against`);
    items = [{ item_id: first.items_id, amount: opts.amount }];
  }

  const refund = await dodo.refunds.create({
    payment_id: paymentId,
    ...(items ? { items } : {}),
    ...(opts.reason ? { reason: opts.reason } : {}),
  });

  return {
    refund_id: refund.refund_id,
    status: refund.status,
    payment_id: refund.payment_id,
    amount: refund.amount ?? undefined,
    currency: refund.currency ?? undefined,
    is_partial: refund.is_partial,
  };
}

export async function getPayment(paymentId: string) {
  return dodoClient().payments.retrieve(paymentId);
}

/**
 * The exact prorated number the guard approves (Stage 2 spike, Sept 14, all green):
 * `immediate_charge.summary.total_amount` is the real charge previewChangePlan
 * reports — trust it over any pre-computed estimate. Currency is read off the
 * summary too, since a plan can in principle re-denominate.
 */
export async function previewPlanChange(
  subscriptionId: string,
  newProductId: string,
): Promise<{ amount: number; currency: string }> {
  const preview = await dodoClient().subscriptions.previewChangePlan(subscriptionId, {
    product_id: newProductId,
    proration_billing_mode: "prorated_immediately",
    quantity: 1,
  });
  const summary = preview.immediate_charge?.summary;
  return {
    amount: summary?.total_amount ?? 0,
    currency: summary?.currency ?? "USD",
  };
}

/**
 * Executes an already-guarded plan change. `on_payment_failure: prevent_change`
 * means a declined card leaves the subscription on its old plan rather than
 * silently switching an unpaid customer up — confirmed against the real API
 * response shape (payment_id/payment_link null on success; charge appears as
 * a separate succeeded payment, verified via payments.list, not assumed).
 */
export async function changePlan(
  subscriptionId: string,
  newProductId: string,
): Promise<PlanChangeResult> {
  const dodo = dodoClient();
  const preview = await previewPlanChange(subscriptionId, newProductId);
  await dodo.subscriptions.changePlan(subscriptionId, {
    product_id: newProductId,
    proration_billing_mode: "prorated_immediately",
    quantity: 1,
    on_payment_failure: "prevent_change",
  });
  // changePlan's own response carries no confirmation fields either way — the
  // subscription record is the source of truth, so re-read it (never assumed).
  // Observed Sept 15: application lag is real and NOT small — one case landed
  // in under a second, another took ~12s (same call, same account, no error in
  // between). A short poll window doesn't distinguish "slow" from "declined";
  // it just makes "slow" look like "declined" and tells the customer something
  // failed when Dodo is still going to charge them a few seconds later. Poll
  // for up to ~20s before giving up, and word the failure as "unconfirmed",
  // never "declined" — this code has no actual evidence a decline occurred,
  // only that the change hadn't landed within the window.
  const POLL_ATTEMPTS = 20;
  const POLL_DELAY_MS = 1000;
  let sub = await dodo.subscriptions.retrieve(subscriptionId);
  for (let i = 0; i < POLL_ATTEMPTS && sub.product_id !== newProductId; i++) {
    await new Promise((r) => setTimeout(r, POLL_DELAY_MS));
    sub = await dodo.subscriptions.retrieve(subscriptionId);
  }
  if (sub.product_id !== newProductId) {
    throw new Error(
      `changePlan outcome UNCONFIRMED after ${POLL_ATTEMPTS} checks (~${(POLL_ATTEMPTS * POLL_DELAY_MS) / 1000}s): ` +
        `subscription ${subscriptionId} still reads ${sub.product_id}, expected ${newProductId}. ` +
        `Not necessarily a decline — Dodo has been observed applying a change tens of ` +
        `seconds late. Check the subscription and this customer's payments directly ` +
        `before assuming failure; the idempotency store leaves this ticket "in_flight" ` +
        `on purpose so nothing retries on top of a change that may still land.`,
    );
  }
  return {
    subscription_id: subscriptionId,
    new_product_id: newProductId,
    charged_amount: preview.amount,
    currency: preview.currency,
  };
}

/** Succeeded payments only — what the demo can actually refund. */
export async function listSucceededPayments() {
  const results = [];
  for await (const p of dodoClient().payments.list({ status: "succeeded" })) {
    results.push(p);
  }
  return results;
}

/** This module as a PaymentProvider — what getPayments() hands the agents. */
export const dodoPayments: PaymentProvider = {
  name: "dodo",
  createRefund,
  previewPlanChange,
  changePlan,
  // Narrowed to the three charge facts the pre-refund cross-check reads, so
  // the seam never leaks Dodo's full payment object into provider-neutral code.
  getPayment: async (paymentId) => {
    const p = await getPayment(paymentId);
    return { total_amount: p.total_amount, currency: p.currency, status: p.status };
  },
};
