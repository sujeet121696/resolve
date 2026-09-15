// Idempotency store tests (Stage 2 build item A3) — the "double-fire" category.
//
// store.ts is file-backed against the REAL data/actions.json (no test-mode
// override exists), so every test below uses a ticket id namespaced under
// "test-store-" and deletes exactly those keys afterward — real demo tickets
// (Ravi, Priya, Meera) are never touched.
//
// This is the mechanism the Sept 14 Dodo spike proved is load-bearing: Dodo
// itself does NOT dedupe a repeated changePlan/refund call, so this file is
// the only thing standing between a flaky retry and a second real charge.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { beginAction, completeAction, getAction } from "../store.js";

const STORE_FILE = path.resolve(process.cwd(), "data", "actions.json");

function cleanup(ticketId: string) {
  try {
    const records = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    delete records[ticketId];
    fs.writeFileSync(STORE_FILE, JSON.stringify(records, null, 2));
  } catch {
    // No store file yet — nothing to clean.
  }
}

test("an unknown ticket has no action record", () => {
  assert.equal(getAction("test-store-never-seen"), undefined);
});

test("beginAction writes an in_flight record the caller can read back", () => {
  const ticketId = "test-store-in-flight-1";
  try {
    beginAction(ticketId, "refund");
    const record = getAction(ticketId);
    assert.equal(record?.state, "in_flight");
    assert.equal(record?.action, "refund");
  } finally {
    cleanup(ticketId);
  }
});

test("completeAction transitions in_flight to done, with the result attached", () => {
  const ticketId = "test-store-complete-1";
  try {
    beginAction(ticketId, "plan_change");
    completeAction(ticketId, { charged_amount: 1500, currency: "USD" });
    const record = getAction(ticketId);
    assert.equal(record?.state, "done");
    assert.deepEqual(record?.result, { charged_amount: 1500, currency: "USD" });
  } finally {
    cleanup(ticketId);
  }
});

test("completeAction refuses a ticket with no in-flight record — nothing to complete", () => {
  const ticketId = "test-store-orphan-complete";
  assert.throws(() => completeAction(ticketId, {}));
});

// --- The actual double-fire scenario ---
//
// resolve-case.ts's real gate is: read getAction() BEFORE calling
// beginAction(); "done" → return the prior result, never re-execute. This
// reproduces that exact check, since it's the only thing that would have
// stopped the Sept 14 double-charge had it been in front of the raw Dodo call.

test("a ticket already marked done must never be actioned a second time", () => {
  const ticketId = "test-store-double-fire";
  try {
    beginAction(ticketId, "plan_change");
    completeAction(ticketId, { charged_amount: 1500, currency: "USD" });

    // Simulates resolve-case.ts's gate: caller checks state before acting.
    const existing = getAction(ticketId);
    const wouldActAgain = existing?.state !== "done";
    assert.equal(wouldActAgain, false, "a done ticket must short-circuit before any second money call");
    assert.deepEqual(existing?.result, { charged_amount: 1500, currency: "USD" });
  } finally {
    cleanup(ticketId);
  }
});

test("a ticket stuck in_flight (e.g. a crash mid-action) is refused, not silently retried", () => {
  const ticketId = "test-store-stuck";
  try {
    beginAction(ticketId, "plan_change"); // never completed — simulates a crash

    const existing = getAction(ticketId);
    const wouldBlock = existing?.state === "in_flight";
    assert.equal(wouldBlock, true, "an in_flight ticket must block for manual review, not retry automatically");
  } finally {
    cleanup(ticketId);
  }
});
