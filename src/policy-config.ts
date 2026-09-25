// Policy-as-config (Stage 2 build-menu filler) — the guard's numbers live in
// one plain, merchant-editable file instead of being buried in code. This is
// the "policy-as-config" roadmap line (JUDGE-PREP.md) made real, in its
// simplest possible form: a business changes what the agent is allowed to do
// by editing config/policy.json, no redeploy of guard logic required.
//
// Env vars still win when set (AUTO_REFUND_LIMIT_<CCY>, RETURN_WINDOW_DAYS,
// ESCALATION_FOLLOWUP_MINUTES) — that stays the ops-level override for a demo
// or an incident. This file is the source of truth a non-engineer is actually
// shown; the numbers in DEFAULT_POLICY exactly match what policy-guard.ts and
// escalation.ts hardcoded before this file existed, so a missing or broken
// config/policy.json changes nothing at runtime — it only ever adds a way to
// change behavior, never a new way to lose the safe default.

import fs from "node:fs";
import path from "node:path";

export interface Policy {
  currencies: Record<string, { auto_approve_limit: number }>;
  return_window_days: number;
  escalation_followup_minutes: number;
}

const DEFAULT_POLICY: Policy = {
  currencies: {
    INR: { auto_approve_limit: 500_000 }, // ₹5,000
    USD: { auto_approve_limit: 5_000 }, //   $50
  },
  return_window_days: 14,
  escalation_followup_minutes: 60,
};

const POLICY_FILE = path.resolve(process.cwd(), "config", "policy.json");

let cached: Policy | null = null;

/**
 * Loaded once per process and cached — this is read on the hot path of every
 * guard check. Missing file, bad JSON, or a currency with a non-numeric limit
 * all fall back to DEFAULT_POLICY's value for that field rather than throwing:
 * a merchant's typo in a plain-language file must never be the reason the
 * whole guard goes down.
 */
export function getPolicy(): Policy {
  if (cached) return cached;
  cached = loadPolicy();
  return cached;
}

function loadPolicy(): Policy {
  let parsed: Partial<Policy> | undefined;
  try {
    parsed = JSON.parse(fs.readFileSync(POLICY_FILE, "utf8"));
  } catch {
    return DEFAULT_POLICY;
  }
  const currencies: Policy["currencies"] = { ...DEFAULT_POLICY.currencies };
  for (const [ccy, entry] of Object.entries(parsed?.currencies ?? {})) {
    const limit = Number((entry as { auto_approve_limit?: unknown })?.auto_approve_limit);
    if (Number.isFinite(limit)) currencies[ccy.toUpperCase()] = { auto_approve_limit: limit };
  }
  const returnWindow = Number(parsed?.return_window_days);
  const followupMinutes = Number(parsed?.escalation_followup_minutes);
  return {
    currencies,
    return_window_days: Number.isFinite(returnWindow) ? returnWindow : DEFAULT_POLICY.return_window_days,
    escalation_followup_minutes: Number.isFinite(followupMinutes)
      ? followupMinutes
      : DEFAULT_POLICY.escalation_followup_minutes,
  };
}

// Auto-approve ceilings in MINOR UNITS, per currency.
//
// One global number cannot serve two currencies: 500_000 is ₹5,000 but also
// $5,000, so pointing the order source at a USD store would have raised the
// real ceiling roughly a hundredfold without changing a line of config. The
// ceiling is a money decision, so it has to be denominated.
//
// Shared by the guard's hard check AND every brain's judgment prompt, so the
// number the model reasons about is always the number the code enforces.
// Override per currency with AUTO_REFUND_LIMIT_<CCY> (e.g.
// AUTO_REFUND_LIMIT_USD) for an ops-level demo/incident escape hatch.
/**
 * The ceiling for a currency, or undefined when we have no ruling for it.
 *
 * Undefined is a real answer, not an error case — see the unknown_currency hard
 * check in policy-guard.ts. AUTO_REFUND_LIMIT (unsuffixed) is honoured for INR
 * only, so existing deployments that set it keep the exact ceiling they had.
 */
export function limitFor(currency: string | undefined): number | undefined {
  const ccy = currency?.trim().toUpperCase();
  if (!ccy) return undefined;
  const configured =
    process.env[`AUTO_REFUND_LIMIT_${ccy}`] ??
    (ccy === "INR" ? process.env.AUTO_REFUND_LIMIT : undefined) ??
    getPolicy().currencies[ccy]?.auto_approve_limit;
  if (configured === undefined) return undefined;
  const limit = Number(configured);
  return Number.isFinite(limit) ? limit : undefined;
}
