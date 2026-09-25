// Policy-Guard — the trust layer that makes "AI touches money" safe.
//
// Two stages, in order (DESIGN.md decision 4):
//   1. HARD checks: plain code, deterministic, cannot be argued with. The guard
//      sees structured CaseFacts only — never the conversation transcript — so
//      prompt injection has nothing to grab.
//   2. Judgment call: the brain (mock or Claude) weighs history + confidence.
//      Only reached when every hard check passes.

import { neverShipped, type GuardVerdict, type ResolutionProposal } from "../types.js";
import { getBrain } from "../brain.js";
import { emitEvent } from "../events.js";
import { getPolicy, limitFor } from "../policy-config.js";

// Store-wide return window; a product can override it via return_window_days.
// Source of truth is config/policy.json; RETURN_WINDOW_DAYS env var still wins
// when set.
const RETURN_WINDOW_DAYS = Number(process.env.RETURN_WINDOW_DAYS ?? getPolicy().return_window_days);

// Ownership enforcement is opt-in: the check itself always runs at context
// load and lands in the facts + audit trail, but denying on it presumes the
// order platform's email records are trustworthy. Flip on with
// OWNERSHIP_ENFORCE=true once they are.
const OWNERSHIP_ENFORCE = /^true$/i.test(process.env.OWNERSHIP_ENFORCE ?? "");

/**
 * Is a physical parcel still owed to us on this order?
 *
 * True only for a returnable item that hasn't come back. Digital goods and
 * non-returnable physical goods (perishable, opened hygiene, custom-made,
 * final sale) both carry `not_required` — there is no parcel, so there is
 * nothing to wait for and the refund must not be gated on one. An order the
 * platform says never shipped is the same situation from the other end: the
 * customer has nothing to send back.
 */
function returnOwed(facts: {
  item_type: string;
  return_status: string;
  fulfillment_status?: string;
}): boolean {
  if (facts.item_type !== "physical") return false;
  if (neverShipped(facts.fulfillment_status)) return false;
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

  // The hard checks judge the CLAIM, not the model's mood. A refund claim used
  // to be checked only when the model happened to propose "refund"; if it
  // proposed "escalate" instead, an out-of-window or over-limit order skipped
  // Stage 1 and was stopped (safely) by the model's own judgement, so the same
  // order could be denied for a different reason on each run. Checking the
  // claim as a refund whatever was proposed makes the reason deterministic.
  // Escalating to a human stays safe either way — this only fixes WHY.
  const checkAs: ResolutionProposal["action"] =
    facts.claim_type === "refund" && (action === "escalate" || action === "refuse")
      ? "refund"
      : action;

  // --- Stage 1: hard checks (code, not model) ---
  if (!ctx.verified) {
    return hardDeny("unverified", "caller has not passed OTP verification");
  }
  // Second identity check: the caller proved they own the EMAIL (OTP above);
  // this one is whether the email owns the ORDER, per the order system's own
  // records (case-context.ts sets it; "unknown" never denies). Ahead of the
  // money checks on purpose — a case built on someone else's order should not
  // even be argued about on amount.
  if (OWNERSHIP_ENFORCE && facts.ownership === "mismatch") {
    return hardDeny(
      "ownership_mismatch",
      `order ${facts.order_id} does not belong to the verified caller's email in the order system`,
    );
  }
  if (checkAs === "refund" || checkAs === "plan_change") {
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
  if (checkAs === "refund" && !facts.payment_id) {
    return hardDeny("no_payment", "refund proposed but no payment is linked to the order");
  }
  // ON_HOLD is the order platform saying "something is wrong with this order"
  // — fraud review, a stuck cancellation, an inventory dispute. Refunding into
  // that is a human's call, whatever the amount.
  if (checkAs === "refund" && facts.fulfillment_status?.toUpperCase() === "ON_HOLD") {
    return hardDeny(
      "order_on_hold",
      `order ${facts.order_id} is ON_HOLD in the order system — a hold must be resolved by a human before money moves`,
    );
  }
  if (checkAs === "plan_change" && (!facts.subscription_id || !facts.requested_product_id)) {
    return hardDeny(
      "no_subscription",
      "plan_change proposed but no subscription/target plan is linked to the order",
    );
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
  if (checkAs === "refund" && returnOwed(facts)) {
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
