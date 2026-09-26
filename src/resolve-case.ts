// resolve_case — the full chain (Step 4):
//   facts → Resolution agent → Policy-Guard → refund → helpdesk note
//
// Provider-neutral: the refund goes through the payments seam and the note
// through the helpdesk seam, so swapping either vendor doesn't touch this file.
//
// Order matters for safety:
//   - idempotency record is written BEFORE the money call (crash ≠ double refund)
//   - the returned confirmation comes from the provider's actual response,
//     never assumed

import type { CaseFacts, GuardVerdict, ResolutionProposal } from "./types.js";
import { proposeResolution } from "./agents/resolution.js";
import { guardCheck, type GuardContext } from "./agents/policy-guard.js";
import { getPayments, type PlanChangeResult, type RefundResult } from "./payments.js";
import { getHelpdesk } from "./helpdesk.js";
import { escalateCase } from "./agents/escalation.js";
import { requestReturn, withLiveReturnStatus, type ReturnRequestResult } from "./returns.js";
import { sendResolutionEmail } from "./notify.js";
import { beginAction, completeAction, getAction } from "./store.js";
import { emitEvent } from "./events.js";

/**
 * Everything the chain needs that is NOT a decision input. Kept out of
 * CaseFacts on purpose: facts go into the guard's prompt, and the customer's
 * address has no business being there (DESIGN.md decision 4).
 */
export interface ResolveOptions {
  /** Customer address for the confirmation email; omitted → no mail. */
  notify_email?: string;
  /** What the caller heard, e.g. "₹1,499", so the email matches the call. */
  amount_narrated?: string;
}

export interface ResolveCaseResult {
  ticket_id: string;
  outcome:
    | "resolved"
    | "denied"
    | "return_requested"
    | "already_resolved"
    | "in_flight_blocked"
    | "unsupported"
    | "provider_error";
  proposal?: ResolutionProposal;
  verdict?: GuardVerdict;
  refund?: RefundResult;
  plan_change?: PlanChangeResult;
  /** Set when the guard held the refund pending a physical return. */
  return_request?: ReturnRequestResult;
  prior_result?: unknown;
  note: string;
}

/**
 * The approved money call threw (provider rejection, timeout, bad payment id).
 *
 * Three rules, all deliberate:
 *  - The raw error goes to the audit log ONLY. It never rides back in `note` or
 *    a message: provider text reaches the customer through every surface.
 *  - The action stays `in_flight`. After a throw we cannot know whether the
 *    provider moved money (a timeout can follow a successful charge), so a
 *    retry could pay twice. The idempotency gate then refuses further attempts
 *    until a human has checked the payment — the safe direction, same as a crash.
 *  - A human is told: the ticket is escalated, because the customer has just
 *    been promised a specialist will follow up.
 */
async function providerFailed(
  facts: CaseFacts,
  proposal: ResolutionProposal,
  verdict: GuardVerdict,
  what: "refund" | "plan change",
  err: unknown,
): Promise<ResolveCaseResult> {
  emitEvent(
    "money.failed",
    `${what} call failed for ${facts.ticket_id} — left in_flight; check the payment before any retry: ${(err as Error).message}`,
    { ticket_id: facts.ticket_id, payment_id: facts.payment_id },
  );
  let escalationNote = "";
  try {
    const esc = await escalateCase(facts, proposal, {
      ...verdict,
      decision: "deny",
      reason: `payment provider error while executing the approved ${what}; whether money moved is UNCONFIRMED — check the payment before retrying`,
    });
    escalationNote = ` ${esc.note}`;
  } catch (escErr) {
    emitEvent("case.warn", `Escalation failed (provider error stands): ${(escErr as Error).message}`);
  }
  return {
    ticket_id: facts.ticket_id,
    outcome: "provider_error",
    proposal,
    verdict,
    note: `The ${what} did not complete because of a payment-provider error (details in the audit log). Held for manual review.${escalationNote}`,
  };
}

export async function resolveCase(
  snapshot: CaseFacts,
  ctx: GuardContext,
  opts: ResolveOptions = {},
): Promise<ResolveCaseResult> {
  // The parcel may have arrived since the context was looked up, so the return
  // status is re-read from the RMA store here rather than trusted from a cached
  // snapshot. Everything downstream decides on these facts.
  let facts = withLiveReturnStatus(snapshot);

  emitEvent("case.received", `Case ${facts.ticket_id}: ${facts.claim_type} claim on order ${facts.order_id}`, {
    amount: facts.amount,
    currency: facts.currency,
  });

  // Idempotency gate — one action per ticket, ever. Checked BEFORE the
  // plan_change live-preview call below: an already-done or already-in-flight
  // ticket should never spend an extra Dodo API call just to be told no.
  const existing = getAction(facts.ticket_id);
  if (existing?.state === "done") {
    emitEvent("case.idempotent", `Ticket ${facts.ticket_id} already actioned — returning prior result`);
    return {
      ticket_id: facts.ticket_id,
      outcome: "already_resolved",
      prior_result: existing.result,
      note: `Action already completed at ${existing.finished_at} — no second action taken.`,
    };
  }
  if (existing?.state === "in_flight") {
    emitEvent("case.warn", `Ticket ${facts.ticket_id} has an IN-FLIGHT action — blocking, needs manual check`);
    return {
      ticket_id: facts.ticket_id,
      outcome: "in_flight_blocked",
      note: `A previous action started at ${existing.started_at} and never finished. Blocked for manual review.`,
    };
  }

  // For plan_change, the guard must approve the REAL prorated charge, not
  // whatever amount the ticket/conversation carried in — that number is
  // unknowable until Dodo computes proration against the live subscription
  // state (Sept 14 spike, Q1). Overlaying it here (a fresh object —
  // withLiveReturnStatus can return the same reference, and snapshot must
  // never be mutated under the caller) means the guard, the audit log, and
  // the executed charge all agree on the same source of truth instead of
  // three different numbers. Runs after the idempotency gate so an
  // already-done or in-flight ticket never spends a Dodo call to be told no.
  if (facts.claim_type === "plan_change" && facts.subscription_id && facts.requested_product_id) {
    try {
      const preview = await getPayments().previewPlanChange(
        facts.subscription_id,
        facts.requested_product_id,
      );
      facts = { ...facts, amount: preview.amount, currency: preview.currency };
      emitEvent(
        "case.plan_change_previewed",
        `Live prorated charge for ${facts.ticket_id}: ${preview.amount} ${preview.currency}`,
      );
    } catch (err) {
      emitEvent(
        "case.warn",
        `Plan-change preview failed (guard will see the pre-computed amount, not live): ${(err as Error).message}`,
      );
    }
  }

  const proposal = await proposeResolution(facts);
  const verdict = await guardCheck(proposal, ctx);

  if (verdict.decision === "deny") {
    // Not every denial is a dead end. A physical item that hasn't come back is
    // a "not yet" with an automatable next step, so it goes to the return flow
    // rather than to a human — and requestReturn is idempotent per order, so a
    // second attempt reports the existing RMA instead of raising another.
    if (verdict.hard_check_failed === "awaiting_return") {
      const returnRequest = await requestReturn(facts, opts.amount_narrated);
      return {
        ticket_id: facts.ticket_id,
        outcome: "return_requested",
        proposal,
        verdict,
        return_request: returnRequest,
        note: `Refund held pending return. ${returnRequest.note}`,
      };
    }

    // Escalation must not turn a clean denial into a 500 — the customer
    // still gets the "specialist will follow up" answer either way.
    let escalationNote = "";
    try {
      const esc = await escalateCase(facts, proposal, verdict);
      escalationNote = ` ${esc.note}`;
    } catch (err) {
      emitEvent("case.warn", `Escalation failed (denial stands): ${(err as Error).message}`);
    }
    return {
      ticket_id: facts.ticket_id,
      outcome: "denied",
      proposal,
      verdict,
      note: `Guard denied: ${verdict.reason}.${escalationNote}`,
    };
  }

  // The resolution agent can decline on its own — it sees the return window and
  // the history too, and sometimes catches an out-of-policy claim before the
  // guard does. That has to reach a real human: the customer is told a
  // specialist will follow up, so a specialist must actually be briefed.
  if (proposal.action === "escalate" || proposal.action === "refuse") {
    let escalationNote = "";
    try {
      const esc = await escalateCase(facts, proposal, verdict);
      escalationNote = ` ${esc.note}`;
    } catch (err) {
      emitEvent("case.warn", `Escalation failed (proposal stands): ${(err as Error).message}`);
    }
    return {
      ticket_id: facts.ticket_id,
      outcome: "denied",
      proposal,
      verdict,
      note: `Resolution agent declined to act autonomously: ${proposal.summary}.${escalationNote}`,
    };
  }

  if (proposal.action === "plan_change") {
    // Approved plan change — record first, then fire the money call. Same
    // idempotency contract as refund (top-of-function gate): a crash between
    // these two lines shows up as "in_flight" on the next attempt and gets
    // refused, not silently retried. This is the actual fix for the double-fire
    // risk found in the Sept 14 spike — Dodo itself does NOT dedupe changePlan
    // calls (verified: firing the same call twice created two separate
    // succeeded payments), so this ticket-level gate is the only thing
    // standing between a flaky retry and a second real charge.
    beginAction(facts.ticket_id, "plan_change");
    emitEvent("action.begin", `Plan change authorized for ${facts.ticket_id} — firing Dodo`, {
      subscription_id: facts.subscription_id,
      requested_product_id: facts.requested_product_id,
    });

    let planChange: PlanChangeResult;
    try {
      planChange = await getPayments().changePlan(
        facts.subscription_id!,
        facts.requested_product_id!,
      );
    } catch (err) {
      return providerFailed(facts, proposal, verdict, "plan change", err);
    }
    completeAction(facts.ticket_id, planChange);
    emitEvent(
      "money.plan_change",
      `Subscription ${planChange.subscription_id} → ${planChange.new_product_id}, charged ${planChange.charged_amount} ${planChange.currency}`,
      { ...planChange },
    );

    const helpdesk = getHelpdesk();
    const ticketNumber = Number(facts.ticket_id);
    if (helpdesk.configured() && Number.isFinite(ticketNumber)) {
      try {
        await helpdesk.addNote(
          ticketNumber,
          `<p><b>Resolve — automated resolution</b></p>
           <p>Guard verdict: <b>APPROVED</b> — ${verdict.reason}<br>
           Plan change: subscription <b>${planChange.subscription_id}</b> → <b>${planChange.new_product_id}</b><br>
           Charged: ${(planChange.charged_amount / 100).toFixed(2)} ${planChange.currency}<br>
           Proposal: ${proposal.summary}</p>`,
        );
        emitEvent("freshdesk.note_added", `Resolution note added to ticket #${ticketNumber}`);
      } catch (err) {
        emitEvent("case.warn", `Freshdesk note failed (plan change unaffected): ${(err as Error).message}`);
      }
      try {
        await helpdesk.updateTicket(ticketNumber, { status: 4 }); // 4 = resolved
        emitEvent("freshdesk.ticket_resolved", `Ticket #${ticketNumber} marked resolved`);
      } catch (err) {
        emitEvent("case.warn", `Freshdesk status update failed (plan change unaffected): ${(err as Error).message}`);
      }
    } else {
      emitEvent("freshdesk.skipped", "Freshdesk not configured or non-numeric ticket id — note skipped");
    }

    // Customer confirmation in writing — same contract as refund: best-effort,
    // the change has already applied, so a mail failure is a warning only.
    if (opts.notify_email) {
      await sendResolutionEmail({
        kind: "plan_change",
        to: opts.notify_email,
        ticket_id: facts.ticket_id,
        order_id: facts.order_id,
        new_product_id: planChange.new_product_id,
        charged_narrated:
          planChange.charged_amount > 0
            ? `${(planChange.charged_amount / 100).toFixed(2)} ${planChange.currency}`
            : `${(0).toFixed(2)} ${planChange.currency} (nothing charged today)`,
        subscription_id: planChange.subscription_id,
      });
    } else {
      emitEvent("notify.skipped", "No customer address for this case — confirmation email skipped");
    }

    emitEvent("case.resolved", `Case ${facts.ticket_id} resolved — plan change to ${planChange.new_product_id}`);
    return {
      ticket_id: facts.ticket_id,
      outcome: "resolved",
      proposal,
      verdict,
      plan_change: planChange,
      note: `Plan changed to ${planChange.new_product_id}, charged ${(planChange.charged_amount / 100).toFixed(2)} ${planChange.currency} — confirmed from Dodo's response.`,
    };
  }

  if (proposal.action !== "refund") {
    return {
      ticket_id: facts.ticket_id,
      outcome: "unsupported",
      proposal,
      verdict,
      note: `Action '${proposal.action}' approved but not executable yet.`,
    };
  }

  // Payment cross-check — the last look before money moves. The payment id
  // rides in on the order's note, so before firing a refund against it, ask
  // the provider what that charge actually is: it must be a SUCCEEDED charge,
  // in the SAME currency, that COVERS the approved amount (>=, not equality —
  // a charge can legitimately exceed the order; refunding more than was ever
  // charged is the direction that must be impossible). Catches a mis-linked
  // payment id before it becomes a wrong refund. A provider READ failure
  // degrades to proceeding — the refund call itself remains the authoritative
  // gate and fails safely above — but a real mismatch is a denial with a
  // human brief, never a money call.
  const provider = getPayments();
  if (provider.getPayment) {
    let charge: Awaited<ReturnType<NonNullable<typeof provider.getPayment>>> | undefined;
    try {
      charge = await provider.getPayment(facts.payment_id!);
    } catch (err) {
      emitEvent(
        "case.warn",
        `Payment cross-check unavailable for ${facts.payment_id} (proceeding — the refund call is still the gate): ${(err as Error).message}`,
      );
    }
    if (charge) {
      const covers = (charge.total_amount ?? 0) >= facts.amount;
      const sameCurrency = (charge.currency ?? "") === facts.currency;
      const succeeded = charge.status === "succeeded";
      if (!covers || !sameCurrency || !succeeded) {
        const reason =
          `hard check 'payment_mismatch': payment ${facts.payment_id} is ` +
          `${charge.total_amount ?? "?"} ${charge.currency ?? "?"} (${charge.status ?? "?"}) — ` +
          `cannot back the approved ${facts.amount} ${facts.currency} refund`;
        emitEvent("guard.denied", reason, { hard_check: "payment_mismatch", ticket_id: facts.ticket_id });
        const denyVerdict: GuardVerdict = {
          decision: "deny",
          reason,
          hard_check_failed: "payment_mismatch",
        };
        let escalationNote = "";
        try {
          const esc = await escalateCase(facts, proposal, denyVerdict);
          escalationNote = ` ${esc.note}`;
        } catch (err) {
          emitEvent("case.warn", `Escalation failed (payment-mismatch denial stands): ${(err as Error).message}`);
        }
        return {
          ticket_id: facts.ticket_id,
          outcome: "denied",
          proposal,
          verdict: denyVerdict,
          note: `Refund blocked before execution: ${reason}.${escalationNote}`,
        };
      }
      emitEvent(
        "payment.crosscheck",
        `Payment ${facts.payment_id} verified: ${charge.total_amount} ${charge.currency} succeeded charge covers the approved ${facts.amount} ${facts.currency}`,
        { ticket_id: facts.ticket_id, payment_id: facts.payment_id },
      );
    }
  }

  // Approved refund — record first, then fire the money call.
  beginAction(facts.ticket_id, "refund");
  emitEvent("action.begin", `Refund authorized for ${facts.ticket_id} — firing Dodo`, {
    payment_id: facts.payment_id,
  });

  let refund: RefundResult;
  try {
    refund = await getPayments().createRefund(facts.payment_id!, {
      reason: `Resolve: ${proposal.summary}`,
    });
  } catch (err) {
    return providerFailed(facts, proposal, verdict, "refund", err);
  }
  completeAction(facts.ticket_id, refund);
  // order_id + customer_email ride along so the audit line is attributable —
  // the guard's velocity caps count these events per customer per day.
  emitEvent("money.refund", `Refund ${refund.refund_id} → ${refund.status}`, {
    ...refund,
    order_id: facts.order_id,
    customer_email: facts.customer_email,
  });

  // Helpdesk note — the audit trail on the ticket. Failure here must not
  // undo the (already completed) refund; it's logged and the case continues.
  const helpdesk = getHelpdesk();
  const ticketNumber = Number(facts.ticket_id);
  if (helpdesk.configured() && Number.isFinite(ticketNumber)) {
    try {
      await helpdesk.addNote(
        ticketNumber,
        `<p><b>Resolve — automated resolution</b></p>
         <p>Guard verdict: <b>APPROVED</b> — ${verdict.reason}<br>
         Refund: <b>${refund.refund_id}</b> (${refund.status})<br>
         Amount: ${((refund.amount ?? 0) / 100).toFixed(2)} ${refund.currency ?? ""} against payment ${refund.payment_id}<br>
         Proposal: ${proposal.summary}</p>`,
      );
      emitEvent("freshdesk.note_added", `Resolution note added to ticket #${ticketNumber}`);
    } catch (err) {
      emitEvent("case.warn", `Freshdesk note failed (refund unaffected): ${(err as Error).message}`);
    }

    // The money has moved, so the ticket must stop reading "open": a resolved
    // case that still looks untouched is exactly the one an agent picks up and
    // handles twice. Its own try, separate from the note — losing the audit
    // note should not also leave the queue wrong.
    try {
      await helpdesk.updateTicket(ticketNumber, { status: 4 }); // 4 = resolved
      emitEvent("freshdesk.ticket_resolved", `Ticket #${ticketNumber} marked resolved`);
    } catch (err) {
      emitEvent("case.warn", `Freshdesk status update failed (refund unaffected): ${(err as Error).message}`);
    }
  } else {
    emitEvent("freshdesk.skipped", "Freshdesk not configured or non-numeric ticket id — note skipped");
  }

  // Customer confirmation in writing. Best-effort by contract: the refund is
  // already done, so sendResolutionEmail swallows its own failures.
  if (opts.notify_email) {
    await sendResolutionEmail({
      kind: "refund",
      to: opts.notify_email,
      ticket_id: facts.ticket_id,
      order_id: facts.order_id,
      amount_narrated:
        opts.amount_narrated ?? `${(facts.amount / 100).toFixed(2)} ${facts.currency}`,
      refund_id: refund.refund_id,
      refund_status: refund.status,
    });
  } else {
    emitEvent("notify.skipped", "No customer address for this case — confirmation email skipped");
  }

  emitEvent("case.resolved", `Case ${facts.ticket_id} resolved — refund ${refund.status}`);
  return {
    ticket_id: facts.ticket_id,
    outcome: "resolved",
    proposal,
    verdict,
    refund,
    note: `Refund ${refund.refund_id} ${refund.status} — confirmed from Dodo's response.`,
  };
}
