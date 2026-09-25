// get_context (Step 6) — builds the case from two systems of record: the
// helpdesk for the complaint, the order source for the facts.
//
// The order itself is the verified email's LATEST order per the order system's
// own records — the ticket's ORD-xxxx display number is only a fallback for
// when the order source cannot answer. Amount, payment reference, item type,
// returnability, delivery date and customer history all come from the order
// source (oms.ts); where the parcel is comes from the RMA store (returns.ts).
// Nothing the customer writes in the ticket — and nothing they say in the
// conversation — can move any of them.
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

import { neverShipped, type CaseFacts } from "./types.js";
import type { OrderRecord } from "./oms.js";
import type { ReturnRecord } from "./returns.js";
import { getHelpdesk } from "./helpdesk.js";
import { createTicket } from "./integrations/freshdesk.js";
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
  fulfillmentStatus?: string,
): CaseFacts["return_status"] {
  if (itemType === "digital" || !returnable) return "not_required";
  // Never shipped → the customer has nothing to send back, whatever the RMA
  // store says. Without this the facts self-contradicted (an UNFULFILLED order
  // carrying "return not started"), and the resolution brain rightly escalated
  // a case the guard would have approved.
  if (neverShipped(fulfillmentStatus)) return "not_required";
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

  // The voice relay passes the Freshdesk ticket id itself as conversationId —
  // fetching it directly sidesteps Freshdesk's ticket-search index, which can
  // lag a few seconds behind a ticket only just created for this very call
  // (search would otherwise resolve to a stale, unrelated older ticket).
  let ticket = await helpdesk.getTicket(Number(conversationId)).catch(() => undefined);

  if (!ticket) {
    if (tickets.length === 0) {
      // No prior ticket for this caller at all — a real first-time contact.
      // Freshdesk-specific on purpose (see the Helpdesk interface's own
      // comment on why createTicket isn't part of it): every call should
      // leave a record for a human to find, even one we can't self-serve.
      ticket = await createTicket({
        subject: "Support call — details pending",
        descriptionHtml: "New voice/chat contact — no prior ticket on file for this email.",
        email: normalizedEmail,
        name: normalizedEmail,
      }).catch((err) => {
        emitEvent("context.ticket_create_failed", `Could not create a ticket for ${normalizedEmail}: ${(err as Error).message}`);
        return undefined;
      });
      if (!ticket) {
        return { found: false, message: "No account or open ticket found for that email address." };
      }
    } else {
      // Newest ticket wins; the list API omits bodies, so fetch the full ticket.
      const newest = [...tickets].sort((a, b) => b.id - a.id)[0];
      ticket = await helpdesk.getTicket(newest.id);
    }
  }

  // The order is the verified email's LATEST order, per the order system's own
  // records (Sujeet's call, Sept 25): the ticket's ORD-xxxx is a display number
  // typed by whoever wrote the ticket, so the order platform's own newest-order
  // answer for the OTP-verified email outranks it. Ownership holds by
  // construction — the id comes from a search over that email's orders, never
  // from anything the caller says or wrote. The ticket-named id survives only
  // as the fallback for when the order source cannot answer (local OMS, API
  // down), and any override is audited.
  const ticketOrderId = (ticket.subject.match(ORDER_ID_RE) ?? ticket.description_text?.match(ORDER_ID_RE))?.[0]?.toUpperCase();
  let orderId = ticketOrderId;

  const orders = getOrderSource();

  if (orders.latestOrderIdForEmail) {
    const latest = await orders.latestOrderIdForEmail(normalizedEmail);
    if (latest) {
      if (ticketOrderId && ticketOrderId !== latest) {
        emitEvent(
          "context.order_latest",
          `Ticket #${ticket.id} names ${ticketOrderId}, but ${normalizedEmail}'s latest order is ${latest} — using the latest (${orders.name})`,
          { conversation_id: conversationId, ticket_order_id: ticketOrderId, order_id: latest },
        );
      } else if (!ticketOrderId) {
        emitEvent(
          "context.order_latest",
          `Ticket #${ticket.id} names no order — using ${latest}, the latest order for ${normalizedEmail} (${orders.name})`,
          { conversation_id: conversationId, order_id: latest },
        );
      }
      orderId = latest;
    }
  }

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

  // Ownership cross-check: the ticket supplied the order id; the order system
  // confirms the order belongs to the verified email. Recorded as a fact and
  // audited on every load — never blocks context assembly. Enforcement (deny
  // at decision time) is the guard's ownership_mismatch hard check, opt-in via
  // OWNERSHIP_ENFORCE so it can be switched on only once the order platform's
  // email data is known to be trustworthy.
  let ownership: CaseFacts["ownership"];
  if (order && orderId && orders.verifyOwnership) {
    ownership = await orders.verifyOwnership(orderId, normalizedEmail);
    emitEvent(
      ownership === "mismatch" ? "context.ownership_mismatch" : "context.ownership",
      `Ownership check for ${orderId} vs ${normalizedEmail}: ${ownership} (${orders.name})`,
      { conversation_id: conversationId, ownership, order_id: orderId },
    );
  }

  // Unknown order → assume a return is owed rather than waived: the cautious
  // side of the gate, and it cannot fire anyway without a payment to refund.
  const returnStatus = classifyReturn(itemType, order?.returnable ?? true, rma, order?.fulfillment_status);

  // "Complete" means the fact this claim type actually needs is present — a
  // payment to refund, or a subscription+target plan to change. Checking
  // payment_id alone would wrongly under-score every valid plan_change case.
  const complete = Boolean(
    (order?.payment_id || (order?.subscription_id && order?.requested_product_id)) &&
      Number.isFinite(order?.amount_minor),
  );
  const facts: CaseFacts = {
    ticket_id: String(ticket.id),
    order_id: orderId ?? "unknown",
    amount: order?.amount_minor ?? 0,
    currency: order?.currency ?? "INR",
    payment_id: order?.payment_id,
    ownership,
    subscription_id: order?.subscription_id,
    requested_product_id: order?.requested_product_id,
    // Structured signal first (order.requested_product_id — the order record
    // the customer cannot write to), same principle as payment_id: never
    // decide what the guard judges from ticket prose alone.
    claim_type: order?.requested_product_id
      ? "plan_change"
      : /refund/i.test(ticket.subject)
        ? "refund"
        : "other",
    item_type: itemType,
    return_status: returnStatus,
    delivered_at: order?.delivered_at,
    return_window_days: order?.return_window_days,
    fulfillment_status: order?.fulfillment_status,
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
      fulfillment_status: order?.fulfillment_status,
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
