// Policy-as-config sketch (Stage 2 build-menu filler) — regression coverage
// for the loader itself. The guard/escalation wiring is exercised implicitly
// by policy-guard.test.ts and store.test.ts already passing with unchanged
// numbers: this file just locks down that the real config/policy.json parses
// into exactly the values the guard has always used, so a merchant's typo in
// that file fails safe (falls back to the old hardcoded default) rather than
// silently changing the auto-approve ceiling.

import { test } from "node:test";
import assert from "node:assert/strict";
import { getPolicy } from "../policy-config.js";

test("the real config/policy.json parses and matches the guard's known-good defaults", () => {
  const policy = getPolicy();
  assert.equal(policy.currencies.INR?.auto_approve_limit, 500_000);
  assert.equal(policy.currencies.USD?.auto_approve_limit, 50_000);
  assert.equal(policy.return_window_days, 14);
  assert.equal(typeof policy.escalation_followup_minutes, "number");
  assert.ok(policy.escalation_followup_minutes > 0);
});

test("getPolicy() is cached — repeated calls return the same values without re-reading the file", () => {
  const first = getPolicy();
  const second = getPolicy();
  assert.deepEqual(first, second);
});
