// Policy-Guard — the trust layer that makes "AI touches money" safe.
//
// Two stages, in order (DESIGN.md decision 4):
//   1. HARD checks: plain code, deterministic, cannot be argued with. The guard
//      sees structured CaseFacts only — never the conversation transcript — so
//      prompt injection has nothing to grab.
//   2. Judgment call: the brain (mock or Claude) weighs history + confidence.
//      Only reached when every hard check passes.

import type { GuardVerdict, ResolutionProposal } from "../types.js";
import { getBrain } from "../brain.js";
import { emitEvent } from "../events.js";

// Auto-approve ceilings in MINOR UNITS, per currency.
//
// One global number cannot serve two currencies: 500_000 is ₹5,000 but also
// $5,000, so pointing the order source at a USD store would have raised the
// real ceiling roughly a hundredfold without changing a line of config. The
// ceiling is a money decision, so it has to be denominated.
//
// Override per currency with AUTO_REFUND_LIMIT_<CCY> (e.g. AUTO_REFUND_LIMIT_USD).
const FALLBACK_LIMITS: Record<string, number> = {
  INR: 500_000, // ₹5,000
  USD: 5_000, //   $50
};

/**
 * The ceiling for a currency, or undefined when we have no ruling for it.
 *
 * Undefined is a real answer, not an error case — see the unknown_currency hard
 * check. AUTO_REFUND_LIMIT (unsuffixed) is honoured for INR only, so existing
 * deployments that set it keep the exact ceiling they had.
 */
function limitFor(currency: string | undefined): number | undefined {
  const ccy = currency?.trim().toUpperCase();
  if (!ccy) return undefined;
  const configured =
    process.env[`AUTO_REFUND_LIMIT_${ccy}`] ??
    (ccy === "INR" ? process.env.AUTO_REFUND_LIMIT : undefined) ??
    FALLBACK_LIMITS[ccy];
  if (configured === undefined) return undefined;
  const limit = Number(configured);
  return Number.isFinite(limit) ? limit : undefined;
}

// Store-wide return window; a product can override it via return_window_days.
const RETURN_WINDOW_DAYS = Number(process.env.RETURN_WINDOW_DAYS ?? 14);

/**
 * Is a physical parcel still owed to us on this order?
 *
 * True only for a returnable item that hasn't come back. Digital goods and
 * non-returnable physical goods (perishable, opened hygiene, custom-made,
 * final sale) both carry `not_required` — there is no parcel, so there is
 * nothing to wait for and the refund must not be gated on one.
 */
function returnOwed(facts: { item_type: string; return_status: string }): boolean {
  if (facts.item_type !== "physical") return false;
  return facts.return_status !== "completed" && facts.return_status !== "not_required";
}

/** Whole days since delivery, or undefined when we don't know when it landed. */
function daysSinceDelivery(deliveredAt?: string): number | undefined {
  if (!deliveredAt) return undefined;
  const ts = Date.parse(deliveredAt);
  if (Number.isNaN(ts)) return undefined;
  return Math.floor((Date.now() - ts) / 86_400_000);
}

export interface GuardContext {
  /** Caller passed the OTP gate (server-side flag, Step 5). */
  verified: boolean;
}

export async function guardCheck(
  proposal: ResolutionProposal,
  ctx: GuardContext,
): Promise<GuardVerdict> {
  const { facts, action } = proposal;

  // --- Stage 1: hard checks (code, not model) ---
  if (!ctx.verified) {
    return hardDeny("unverified", "caller has not passed OTP verification");
  }
  if (action === "refund" || action === "plan_change") {
    const limit = limitFor(facts.currency);
    // No ruling for this currency means we cannot say whether the amount is
    // small. Failing closed is the only safe direction: the alternative is
    // comparing against some other currency's ceiling, which is how a $1,499
    // refund passes a limit that was written to mean ₹5,000.
    if (limit === undefined) {
      return hardDeny(
        "unknown_currency",
        `no auto-approve ceiling configured for ${facts.currency || "an unspecified currency"} — set AUTO_REFUND_LIMIT_${(facts.currency || "XXX").toUpperCase()}`,
      );
    }
    if (facts.amount > limit) {
      return hardDeny(
        "auto_limit",
        `amount ${facts.amount} ${facts.currency} exceeds auto-approve limit ${limit} ${facts.currency}`,
      );
    }
  }
  if (action === "refund" && !facts.payment_id) {
    return hardDeny("no_payment", "refund proposed but no payment is linked to the order");
  }
  // Returnable goods: the parcel comes back before the money goes out. Last of
  // the hard checks on purpose — a returnable item that ALSO breaches the limit
  // is a human's call, not a pickup request. resolve-case routes this one denial
  // to the return flow instead of escalation: it's a "not yet", not a "no".
  //
  // "Physical" is NOT the same as "returnable": perishables, opened hygiene
  // items, custom-made and final-sale goods are physical but nothing comes back.
  // Those carry return_status not_required and must skip this gate entirely —
  // otherwise the refund waits forever on a parcel that can never arrive.
  if (action === "refund" && returnOwed(facts)) {
    // Return window, checked BEFORE arranging anything: no point dispatching a
    // courier for an item that is out of policy. Deliberately skipped once the
    // return is completed — if the warehouse accepted the parcel, that
    // acceptance was the policy decision and the refund stands.
    const windowDays = facts.return_window_days ?? RETURN_WINDOW_DAYS;
    const age = daysSinceDelivery(facts.delivered_at);
    if (age !== undefined && age > windowDays) {
      // A "no", not a "not yet" — so this one goes to a human like any other
      // policy denial. Only the agent can grant an exception, if anyone can.
      return hardDeny(
        "return_window_expired",
        `order ${facts.order_id} was delivered ${age} days ago, outside the ${windowDays}-day return window`,
      );
    }
    return hardDeny(
      "awaiting_return",
      `physical item on order ${facts.order_id} has not been returned (return_status=${facts.return_status})`,
    );
  }

  // --- Stage 2: judgment call via the brain ---
  emitEvent("guard.hard_checks_passed", "Hard checks passed — running judgment call", {
    action,
    amount: facts.amount,
  });
  return getBrain().judge(proposal);
}

function hardDeny(check: string, reason: string): GuardVerdict {
  const verdict: GuardVerdict = {
    decision: "deny",
    reason: `hard check '${check}': ${reason}`,
    hard_check_failed: check,
  };
  emitEvent("guard.denied", verdict.reason, { hard_check: check });
  return verdict;
}
