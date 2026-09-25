// OTP lockout tests — asking for a new code must not undo a lockout.
import { test } from "node:test";
import assert from "node:assert/strict";

// No SMTP configured → sendOtp takes the dev branch (no mail), code is only in memory.
delete process.env.SMTP_HOST;
const { sendOtp, verifyOtp, attemptsLeft } = await import("../otp.js");

test("two wrong codes lock the conversation, and a new code is refused", async () => {
  await sendOtp("c-lock", "a@example.com");
  assert.equal(verifyOtp("c-lock", "000000"), "wrong_code");
  assert.equal(verifyOtp("c-lock", "000001"), "locked");

  const again = await sendOtp("c-lock", "a@example.com");
  assert.equal(again.blocked, "locked");
  assert.equal(verifyOtp("c-lock", "000002"), "locked");
});

test("a new code before lockout resets the attempts", async () => {
  await sendOtp("c-reset", "a@example.com");
  assert.equal(verifyOtp("c-reset", "000000"), "wrong_code");
  assert.equal(attemptsLeft("c-reset"), 1);
  const again = await sendOtp("c-reset", "a@example.com");
  assert.equal(again.blocked, undefined);
  assert.equal(attemptsLeft("c-reset"), 2);
});

test("a conversation gets at most three codes", async () => {
  for (let i = 0; i < 3; i++) {
    assert.equal((await sendOtp("c-cap", "a@example.com")).blocked, undefined);
  }
  assert.equal((await sendOtp("c-cap", "a@example.com")).blocked, "limit");
});
