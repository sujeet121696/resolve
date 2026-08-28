// Dodo Payments wrapper (official Node SDK).
// Gotchas from SPIKES.md, applied here:
//   - DODO_PAYMENTS_ENVIRONMENT=test_mode is mandatory (SDK defaults to live → 401)
//   - keys have no "dodo_test_" prefix
//   - test-mode fees drain the wallet → seed several payments so full refunds clear
//   - test mode rejects INR → all seeded payments are USD, narration dual-labels ₹

import DodoPayments from "dodopayments";
// Type-only import: the shared contract lives in the payments seam, so there
// is no runtime cycle between seam and implementation.
import type { PaymentProvider, RefundResult } from "../payments.js";

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
};
