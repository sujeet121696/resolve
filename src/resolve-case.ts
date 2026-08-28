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
import { getPayments, type RefundResult } from "./payments.js";
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
    | "unsupported";
  proposal?: ResolutionProposal;
  verdict?: GuardVerdict;
  refund?: RefundResult;
  /** Set when the guard held the refund pending a physical return. */
  return_request?: ReturnRequestResult;
  prior_result?: unknown;
  note: string;
}

export async function resolveCase(
  snapshot: CaseFacts,
  ctx: GuardContext,
  opts: ResolveOptions = {},
): Promise<ResolveCaseResult> {
  // The parcel may have arrived since the context was looked up, so the return
  // status is re-read from the RMA store here rather than trusted from a cached
  // snapshot. Everything downstream decides on these facts.
  const facts = withLiveReturnStatus(snapshot);

  emitEvent("case.received", `Case ${facts.ticket_id}: ${facts.claim_type} claim on order ${facts.order_id}`, {
    amount: facts.amount,
    currency: facts.currency,
  });

  // Idempotency gate — one action per ticket, ever.
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

  if (proposal.action !== "refund") {
    return {
      ticket_id: facts.ticket_id,
      outcome: "unsupported",
      proposal,
      verdict,
      note: `Action '${proposal.action}' approved but not executable yet (refunds only in Step 4).`,
    };
  }

  // Approved refund — record first, then fire the money call.
  beginAction(facts.ticket_id, "refund");
  emitEvent("action.begin", `Refund authorized for ${facts.ticket_id} — firing Dodo`, {
    payment_id: facts.payment_id,
  });

  const refund = await getPayments().createRefund(facts.payment_id!, {
    reason: `Resolve: ${proposal.summary}`,
  });
  completeAction(facts.ticket_id, refund);
  emitEvent("money.refund", `Refund ${refund.refund_id} → ${refund.status}`, { ...refund });

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
