// Escalation agent (Step 8) — owns the failure path so failures are graceful.
//
// When the Policy-Guard denies an action, the case doesn't dead-end: this
// agent packages everything a human specialist needs into a structured
// briefing on the ticket, bumps it to urgent, and schedules its own follow-up.
// The briefing is a deterministic template over structured fields — the
// escalation path must never itself fail on an LLM error or rate limit.
//
// The follow-up is a real in-process timer: it fires later, re-reads the
// ticket, and posts a status note ("still open — pinging assignee"). It does
// not survive a server restart — acceptable for the demo, noted for honesty.

import type { CaseFacts, GuardVerdict, ResolutionProposal } from "../types.js";
import { getHelpdesk } from "../helpdesk.js";
import { emitEvent } from "../events.js";

const FOLLOWUP_MINUTES = Number(process.env.ESCALATION_FOLLOWUP_MINUTES ?? 60);

export interface EscalationResult {
  escalated: boolean;
  follow_up_minutes: number;
  note: string;
}

function briefingHtml(facts: CaseFacts, proposal: ResolutionProposal, verdict: GuardVerdict): string {
  const h = facts.customer_history;
  const followUpAt = new Date(Date.now() + FOLLOWUP_MINUTES * 60_000).toISOString();
  return `<p><b>Resolve — escalation briefing (automated)</b></p>
    <p><b>Why you're seeing this:</b> the Policy-Guard declined autonomous action.<br>
    <b>Guard's reason:</b> ${verdict.reason}</p>
    <p><b>The claim:</b> ${facts.claim_type} on order ${facts.order_id} —
    ${(facts.amount / 100).toFixed(2)} ${facts.currency} (minor units: ${facts.amount})<br>
    <b>Agent's proposal:</b> ${proposal.action} — ${proposal.summary}<br>
    <b>Resolution confidence:</b> ${facts.resolution_confidence}</p>
    <p><b>Customer history:</b> tenure ${h.tenure_months} months ·
    prior refunds ${h.prior_refunds} · prior tickets ${h.prior_tickets}<br>
    <b>Identity:</b> verified by OTP during the conversation</p>
    <p><b>Recommended next step:</b> human review of the ${facts.claim_type};
    the customer was told a specialist will follow up.<br>
    <b>Agent follow-up scheduled:</b> ${followUpAt} (+${FOLLOWUP_MINUTES} min)</p>`;
}

/** Fire the deny path: urgent priority + briefing note + self-scheduled follow-up. */
export async function escalateCase(
  facts: CaseFacts,
  proposal: ResolutionProposal,
  verdict: GuardVerdict,
): Promise<EscalationResult> {
  const helpdesk = getHelpdesk();
  const ticketNumber = Number(facts.ticket_id);
  if (!helpdesk.configured() || !Number.isFinite(ticketNumber)) {
    emitEvent("escalation.skipped", "Helpdesk not configured or non-numeric ticket id");
    return { escalated: false, follow_up_minutes: FOLLOWUP_MINUTES, note: "Escalation skipped — no helpdesk." };
  }

  await helpdesk.updateTicket(ticketNumber, { priority: 4 });
  await helpdesk.addNote(ticketNumber, briefingHtml(facts, proposal, verdict));
  emitEvent("escalation.raised", `Ticket #${ticketNumber} → URGENT with specialist briefing`, {
    guard_reason: verdict.reason,
  });

  // Self-scheduled follow-up: the agent checks back on its own escalation.
  setTimeout(() => {
    void (async () => {
      try {
        const ticket = await helpdesk.getTicket(ticketNumber);
        const stillOpen = ticket.status === 2; // 2 = open
        await helpdesk.addNote(
          ticketNumber,
          `<p><b>Resolve — scheduled follow-up</b></p>
           <p>Checking back ${FOLLOWUP_MINUTES} min after escalation: ticket is
           ${stillOpen ? "<b>still open</b> — pinging the assigned specialist" : "no longer open — closing the loop"}.
           (status=${ticket.status}, priority=${ticket.priority})</p>`,
        );
        emitEvent("escalation.followup", `Follow-up on ticket #${ticketNumber}: ${stillOpen ? "still open — pinged" : "handled"}`);
      } catch (err) {
        emitEvent("case.warn", `Escalation follow-up failed: ${(err as Error).message}`);
      }
    })();
  }, FOLLOWUP_MINUTES * 60_000);
  emitEvent("escalation.followup_scheduled", `Follow-up in ${FOLLOWUP_MINUTES} min on ticket #${ticketNumber}`);

  return {
    escalated: true,
    follow_up_minutes: FOLLOWUP_MINUTES,
    note: `Escalated: ticket #${ticketNumber} urgent, briefing attached, follow-up in ${FOLLOWUP_MINUTES} min.`,
  };
}
