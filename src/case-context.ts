// get_context (Step 6) — builds the case from two systems of record: the
// helpdesk for the complaint, the order source for the facts.
//
// The ticket contributes exactly one fact-bearing token: the order id. Amount,
// payment reference, item type, returnability, delivery date and customer
// history all come from the order source (oms.ts); where the parcel is comes
// from the RMA store (returns.ts). Nothing the customer writes in the ticket —
// and nothing they say in the conversation — can move any of them.
//
// This used to regex the order details out of the ticket BODY, which made
// customer-supplied text an input to the guard's numbers and forced the code to
// interpret prose: "not applicable" (no return owed) and "not requested" (a
// return IS owed) read almost alike and were once collapsed, holding a refund
// forever on a parcel that could never arrive. Structured records make that
// class of bug unrepresentable.
//
// Security shape: the assembled CaseFacts — payment_id included — are stored
// HERE, server-side, keyed by conversation_id. The voice agent receives only a
// narratable summary. resolve_case later reads the facts from this store, so
// nothing the caller says can inflate the amount or swap the payment.

import type { CaseFacts } from "./types.js";
import type { OrderRecord } from "./oms.js";
import type { ReturnRecord } from "./returns.js";
import { getHelpdesk } from "./helpdesk.js";
import { getOrderSource } from "./oms.js";
import { getReturn } from "./returns.js";
import { emitEvent } from "./events.js";

// Order ids appear in the subject ("… (ORD-1101)") and usually in the customer's
// own prose too, which is how real support tickets reference an order.
const ORDER_ID_RE = /\bORD-\d+\b/i;

/**
 * What the return gate keys off. `not_required` is the "skip the gate" status
 * and covers BOTH digital goods and non-returnable physical ones.
 *
 * `returnable` is product policy from the order record; the RMA store is a
 * warehouse scan. Policy first: an item that can never come back must never be
 * parked waiting for it, whatever else is true.
 */
export function classifyReturn(
  itemType: CaseFacts["item_type"],
  returnable: boolean,
  rma: Pick<ReturnRecord, "state"> | undefined,
): CaseFacts["return_status"] {
  if (itemType === "digital" || !returnable) return "not_required";
  if (rma) return rma.state === "received" ? "completed" : "requested";
  return "not_started";
}

/** Whole months since an ISO account-open date. 0 when absent or unparseable. */
function monthsSince(iso: string | undefined): number {
  if (!iso) return 0;
  const opened = new Date(iso).getTime();
  if (Number.isNaN(opened)) return 0;
  return Math.max(0, Math.round((Date.now() - opened) / (30.44 * 86_400_000)));
}

export interface CaseContext {
  facts: CaseFacts;
  email: string;
  amount_narrated: string; // "₹1,499" — what the agent says out loud
}

const contexts = new Map<string, CaseContext>(); // keyed by conversation_id

export function getContextFor(conversationId: string): CaseContext | undefined {
  return contexts.get(conversationId);
}

/** What the voice agent is allowed to see — no payment_id, no raw minor units. */
export interface ContextSummary {
  found: boolean;
  ticket_id?: string;
  subject?: string;
  order_id?: string;
  item?: string;
  amount?: string;
  message: string;
}

export async function lookupContext(
  conversationId: string,
  email: string,
): Promise<ContextSummary> {
  const helpdesk = getHelpdesk();
  const normalizedEmail = email.trim().toLowerCase();
  const tickets = await helpdesk.listTicketsByEmail(normalizedEmail);
  if (tickets.length === 0) {
    emitEvent("context.miss", `No tickets found for ${normalizedEmail}`);
    return { found: false, message: "No account or open ticket found for that email address." };
  }

  // Newest ticket wins; the list API omits bodies, so fetch the full ticket.
  const newest = [...tickets].sort((a, b) => b.id - a.id)[0];
  const ticket = await helpdesk.getTicket(newest.id);

  // Subject first: it is the field the helpdesk shows in every list view, so a
  // demo ticket always carries the id there even when the prose is casual.
  const orderId = (ticket.subject.match(ORDER_ID_RE) ?? ticket.description_text?.match(ORDER_ID_RE))?.[0]?.toUpperCase();

  const orders = getOrderSource();
  // An order source that is down, misconfigured or rate-limited must degrade
  // exactly like an unknown order id — never take the call down. A remote source
  // is a network call, so this is the normal case, not the exotic one: the case
  // surfaces with no payment behind it and the guard's no_payment hard check
  // hands it to a human, which is the right answer when we cannot see the order.
  let order: OrderRecord | undefined;
  try {
    order = orderId ? await orders.getOrder(orderId) : undefined;
  } catch (err) {
    emitEvent(
      "context.order_source_failed",
      `${orders.name} order source failed for ${orderId}: ${(err as Error).message}`,
      { conversation_id: conversationId },
    );
  }
  if (!order) {
    // A ticket with no matching order is a real support situation, not a crash:
    // the case is surfaced with no payment behind it, so the guard's no_payment
    // hard check routes it to a human instead of guessing an amount.
    emitEvent(
      "context.order_missing",
      `Ticket #${ticket.id} references ${orderId ?? "no order id"} — not found in the ${orders.name} order source`,
      { conversation_id: conversationId },
    );
  }

  const itemType = order?.item_type ?? "physical";
  const rma = orderId ? getReturn(orderId) : undefined;
  // Unknown order → assume a return is owed rather than waived: the cautious
  // side of the gate, and it cannot fire anyway without a payment to refund.
  const returnStatus = classifyReturn(itemType, order?.returnable ?? true, rma);

  const complete = Boolean(order?.payment_id && Number.isFinite(order?.amount_minor));
  const facts: CaseFacts = {
    ticket_id: String(ticket.id),
    order_id: orderId ?? "unknown",
    amount: order?.amount_minor ?? 0,
    currency: order?.currency ?? "INR",
    payment_id: order?.payment_id,
    claim_type: /refund/i.test(ticket.subject) ? "refund" : "other",
    item_type: itemType,
    return_status: returnStatus,
    delivered_at: order?.delivered_at,
    return_window_days: order?.return_window_days,
    customer_history: {
      tenure_months: monthsSince(order?.customer.since),
      prior_refunds: order?.customer.prior_refunds ?? 0,
      // The one history field taken live from the helpdesk rather than the order.
      prior_tickets: tickets.length,
    },
    // Heuristic until the real brain scores this (Step 3): a complete order
    // record reads as high confidence; a missing one drops below the floor.
    resolution_confidence: complete ? 0.9 : 0.4,
  };

  const item = order?.item ?? "your order";
  const amountNarrated = order?.amount_narrated;

  contexts.set(conversationId, {
    facts,
    email: normalizedEmail,
    amount_narrated: amountNarrated ?? "the charged amount",
  });

  emitEvent(
    "context.loaded",
    `Context for ${normalizedEmail}: ticket #${ticket.id}, ${orderId ?? "no order"}, ${amountNarrated ?? "amount unknown"}`,
    {
      conversation_id: conversationId,
      order_source: orders.name,
      payment_id: order?.payment_id,
      item_type: itemType,
      return_status: returnStatus,
    },
  );

  return {
    found: true,
    ticket_id: String(ticket.id),
    subject: ticket.subject,
    order_id: orderId,
    item,
    amount: amountNarrated,
    message: order
      ? `Found ticket ${ticket.id} about ${item}, order ${orderId}, amount ${amountNarrated}.`
      : `Found ticket ${ticket.id}, but no order record for ${orderId ?? "it"} — a specialist will need to look at this one.`,
  };
}
