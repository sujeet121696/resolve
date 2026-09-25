// Case brief — the read-only, per-ticket view behind /tools/case-brief.
//
// Built for the Freshdesk sidebar app (fdk-app/): when a human agent opens a
// ticket, the panel shows what Resolve did on it — order, guard rulings, RMA
// state, idempotency record, and the related audit events. Everything here is
// derived from files the system already writes; this module never mutates
// anything. It sits behind the /tools token like the other system-to-system
// endpoints — this is for the support agent's screen, not the public tunnel.

import { readAudit } from "./audit.js";
import { getReturn } from "./returns.js";
import { getAction } from "./store.js";

const ORDER_RE = /ORD-\d+/;
const AMOUNT_RE = /\$[\d,]+(?:\.\d+)?/;

export function caseBrief(ticketId: string): Record<string, unknown> {
  const events = readAudit();
  const tag = `ticket #${ticketId},`; // trailing comma avoids #8 matching #84

  // The newest context.loaded line for this ticket names the order and amount.
  const ctx = [...events].reverse().find((e) => e.type === "context.loaded" && e.message.includes(tag));
  const orderId = ctx?.message.match(ORDER_RE)?.[0] ?? null;
  const amount = ctx?.message.match(AMOUNT_RE)?.[0] ?? null;

  const related = events.filter(
    (e) =>
      e.message.includes(tag) ||
      (orderId !== null &&
        (e.message.includes(orderId) || JSON.stringify(e.data ?? {}).includes(orderId))),
  );

  const count = (type: string) => related.filter((e) => e.type === type).length;
  const denials = related
    .filter((e) => e.type === "guard.denied")
    .map((e) => String((e.data as Record<string, unknown>)?.hard_check ?? "judge"));

  return {
    generated_at: new Date().toISOString(),
    ticket_id: ticketId,
    order_id: orderId,
    amount,
    guard: { approved: count("guard.approved"), denied: count("guard.denied"), denial_checks: denials },
    outcomes: {
      refunds: count("money.refund"),
      refunds_blocked: count("money.failed"),
      returns_requested: count("return.requested"),
      escalations: count("escalation.raised"),
    },
    return: (orderId ? getReturn(orderId) : undefined) ?? null,
    action: getAction(ticketId) ?? null,
    events: related.slice(-25).map((e) => ({ ts: e.ts, type: e.type, message: e.message })),
  };
}
