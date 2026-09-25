// A payment-provider failure must reach the customer as a neutral line, never as
// the provider's own text — and must NOT be retried, because after a throw we
// cannot know whether money moved.
//
// resolveCase runs for real (BRAIN=mock, no helpdesk: the ticket id is
// non-numeric so escalation skips the network). Only the Dodo refund call is
// replaced. The idempotency store is the real data/actions.json, so the ticket
// id is namespaced "test-provider-" and removed afterwards (see store.test.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

process.env.BRAIN = "mock";

const { resolveCase } = await import("../resolve-case.js");
const { dodoPayments } = await import("../integrations/dodo.js");
const { getAction } = await import("../store.js");
const { PROVIDER_ERROR_CHAT, PROVIDER_ERROR_VOICE } = await import("../resolution-messages.js");
import type { CaseFacts } from "../types.js";

const STORE_FILE = path.resolve(process.cwd(), "data", "actions.json");

function cleanup(ticketId: string) {
  try {
    const records = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    delete records[ticketId];
    fs.writeFileSync(STORE_FILE, JSON.stringify(records, null, 2));
  } catch {
    /* no store file — nothing to clean */
  }
}

function facts(ticketId: string): CaseFacts {
  return {
    ticket_id: ticketId,
    order_id: "ORD-T",
    amount: 100_000,
    currency: "INR",
    payment_id: "pay_secret_123",
    claim_type: "refund",
    item_type: "digital",
    return_status: "not_required",
    customer_history: { tenure_months: 12, prior_refunds: 0, prior_tickets: 1 },
    resolution_confidence: 0.9,
  };
}

const RAW = "Dodo 422: payment pay_secret_123 not found at /internal/refunds/route.ts";

test("a provider error becomes a neutral outcome, holds the ticket, and is never retried", async () => {
  const ticketId = "test-provider-error-1";
  const original = dodoPayments.createRefund;
  let moneyCalls = 0;
  dodoPayments.createRefund = async () => {
    moneyCalls += 1;
    throw new Error(RAW);
  };
  try {
    const first = await resolveCase(facts(ticketId), { verified: true });
    assert.equal(first.outcome, "provider_error");
    // The customer-facing fields carry none of the provider's text.
    const visible = JSON.stringify({ outcome: first.outcome, note: first.note });
    assert.doesNotMatch(visible, /422|pay_secret_123|internal|route\.ts/);
    assert.equal(first.refund, undefined);

    // Left in_flight on purpose: whether money moved is unknown.
    assert.equal(getAction(ticketId)?.state, "in_flight");

    // A second attempt is refused at the idempotency gate — no second money call.
    const second = await resolveCase(facts(ticketId), { verified: true });
    assert.equal(second.outcome, "in_flight_blocked");
    assert.equal(moneyCalls, 1);
  } finally {
    dodoPayments.createRefund = original;
    cleanup(ticketId);
  }
});

test("the neutral customer wording says nothing technical and asks not to retry", () => {
  for (const msg of [PROVIDER_ERROR_CHAT, PROVIDER_ERROR_VOICE]) {
    assert.doesNotMatch(msg, /\b(error|exception|stack|dodo|422|500)\b/i);
    assert.match(msg, /(not|n't) try again/i);
  }
  // Spoken by ElevenLabs — plain ASCII only.
  assert.match(PROVIDER_ERROR_VOICE, /^[\x00-\x7F]+$/);
});
