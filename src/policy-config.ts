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

/**
 * Optional per-currency velocity caps — all amounts in MINOR UNITS. Entirely
 * absent by default: no `velocity` block in config/policy.json means the guard
 * never runs these checks, byte-for-byte the pre-feature behavior. Adding a
 * guard is adding data, not rearchitecting.
 */
export interface VelocityCaps {
  /** Max refunds one customer may receive per UTC day (0 = none at all). */
  max_refunds_per_customer_per_day?: number;
  /** Max refunded amount per customer per UTC day, minor units. */
  max_amount_per_customer_per_day?: number;
  /** Circuit breaker: total autonomous refund payout per UTC day, minor units. */
  max_total_amount_per_day?: number;
}

export interface Policy {
  currencies: Record<string, { auto_approve_limit: number; velocity?: VelocityCaps }>;
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
    const raw = entry as { auto_approve_limit?: unknown; velocity?: Record<string, unknown> };
    const limit = Number(raw?.auto_approve_limit);
    if (!Number.isFinite(limit)) continue;
    const resolved: Policy["currencies"][string] = { auto_approve_limit: limit };
    // Velocity caps parse the same way as the limit: a non-numeric or negative
    // value reads as "not set" (that cap is skipped), never as zero — a typo
    // must not become a total refund freeze by accident. An explicit 0 IS
    // honoured: it means "no autonomous refunds", which is a valid kill switch.
    const vel = raw?.velocity;
    if (vel && typeof vel === "object") {
      const num = (v: unknown): number | undefined => {
        const n = Number(v);
        return Number.isFinite(n) && n >= 0 ? n : undefined;
      };
      const caps: VelocityCaps = {
        max_refunds_per_customer_per_day: num(vel.max_refunds_per_customer_per_day),
        max_amount_per_customer_per_day: num(vel.max_amount_per_customer_per_day),
        max_total_amount_per_day: num(vel.max_total_amount_per_day),
      };
      if (Object.values(caps).some((c) => c !== undefined)) resolved.velocity = caps;
    }
    currencies[ccy.toUpperCase()] = resolved;
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

/**
 * Velocity caps for a currency, or undefined when none are configured — which
 * is the shipped default. config/policy.json only; no env override on purpose:
 * these are merchant policy numbers, not ops toggles.
 */
export function velocityFor(currency: string | undefined): VelocityCaps | undefined {
  const ccy = currency?.trim().toUpperCase();
  if (!ccy) return undefined;
  return getPolicy().currencies[ccy]?.velocity;
}

/**
 * Live policy update (Admin UI): set or clear the velocity caps for a currency.
 * Writes config/policy.json (preserving fields it doesn't own, e.g. _note keys)
 * AND refreshes the in-process cache in the same call, so the very next guard
 * check obeys the new caps — no restart. Passing undefined (or all-empty caps)
 * removes the block, returning the guard to limits-only behavior.
 */
export function setVelocity(currency: string, caps: VelocityCaps | undefined): Policy {
  const ccy = currency.trim().toUpperCase();
  const known = getPolicy().currencies[ccy];
  if (!known) throw new Error(`unknown currency ${ccy} — add it to config/policy.json first`);
  let file: Record<string, any>;
  try {
    file = JSON.parse(fs.readFileSync(POLICY_FILE, "utf8"));
  } catch {
    file = {};
  }
  const currencies = (file.currencies ??= {});
  const entry = (currencies[ccy] ??= { auto_approve_limit: known.auto_approve_limit });
  const active = caps && Object.values(caps).some((c) => c !== undefined);
  if (active) entry.velocity = caps;
  else delete entry.velocity;
  fs.writeFileSync(POLICY_FILE, JSON.stringify(file, null, 2) + "\n");
  cached = loadPolicy(); // reload from the file just written — one source of truth
  return cached;
}
