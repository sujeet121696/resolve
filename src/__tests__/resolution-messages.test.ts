// Regression test for the Sept 15 wording bug: both chat.ts and server.ts
// hardcoded "Refund approved..." for every "resolved" outcome, so a real
// plan_change case (ticket 7, verified live) came back worded as a refund
// with an empty reference number. These functions must pick their wording
// off which result field actually came back, never off any assumed action.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chatResolvedMessage, voiceResolvedMessage } from "../resolution-messages.js";
import type { ResolveCaseResult } from "../resolve-case.js";

function refundResult(): ResolveCaseResult {
  return {
    ticket_id: "1",
    outcome: "resolved",
    refund: { refund_id: "re_123", status: "succeeded", payment_id: "pay_1", is_partial: false },
    note: "",
  };
}

function planChangeResult(): ResolveCaseResult {
  return {
    ticket_id: "7",
    outcome: "resolved",
    plan_change: {
      subscription_id: "sub_1",
      new_product_id: "pdt_pro",
      charged_amount: 1400,
      currency: "USD",
    },
    note: "",
  };
}

test("chatResolvedMessage words a refund result as a refund, with its reference", () => {
  const msg = chatResolvedMessage(refundResult(), "$10.00");
  assert.match(msg, /Refund approved/);
  assert.match(msg, /re_123/);
  assert.doesNotMatch(msg, /Plan changed/);
});

test("chatResolvedMessage words a plan_change result as a plan change, never a refund", () => {
  const msg = chatResolvedMessage(planChangeResult(), "$10.00/mo (current plan)");
  assert.match(msg, /Plan changed/);
  assert.match(msg, /14\.00 USD/);
  assert.doesNotMatch(msg, /Refund approved/);
});

test("voiceResolvedMessage words a refund result as a refund, with its reference", () => {
  const msg = voiceResolvedMessage(refundResult(), "$10.00");
  assert.match(msg, /Refund approved/);
  assert.match(msg, /re_123/);
});

test("voiceResolvedMessage words a plan_change result as a plan change, never a refund", () => {
  const msg = voiceResolvedMessage(planChangeResult(), "$10.00/mo (current plan)");
  assert.match(msg, /Plan change approved/);
  assert.match(msg, /14\.00 USD/);
  assert.doesNotMatch(msg, /Refund approved/);
});
