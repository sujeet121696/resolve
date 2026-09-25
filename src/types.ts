// Shared contracts. The most important one is CaseFacts — the ONLY thing the
// Policy-Guard ever sees (DESIGN.md decision 4: structured fields, never transcript).

/**
 * Fulfilment states where the order NEVER LEFT the warehouse (Shopify
 * displayFulfillmentStatus). Nothing is with the customer, so no delivery date
 * is real and no return can be owed — the cancel-before-ship case. One
 * definition shared by the Shopify adapter, the context builder and the guard,
 * so "not shipped" cannot mean different things in different places. Lives
 * here (not oms.ts) because this file imports nothing — every consumer can use
 * it without a runtime cycle.
 */
export function neverShipped(status?: string): boolean {
  if (!status) return false;
  const s = status.toUpperCase();
  return s === "UNFULFILLED" || s === "IN_PROGRESS";
}

export interface CaseFacts {
  ticket_id: string;
  order_id: string;
  amount: number; // minor units (cents/paise)
  currency: string;
  payment_id?: string; // Dodo payment behind the order — required for refund actions

  claim_type: "refund" | "plan_change" | "other";

  /**
   * Order ↔ caller cross-check (case-context.ts): does the order the ticket
   * names belong to the OTP-verified email, per the order system's own
   * records? "unknown" means the platform could not answer (missing data, API
   * failure) and is never treated as a mismatch. Always recorded and audited;
   * turning a mismatch into a denial is the guard's ownership_mismatch hard
   * check, gated by OWNERSHIP_ENFORCE=true.
   */
  ownership?: "verified" | "mismatch" | "unknown";

  /**
   * The order platform's fulfilment state (Shopify displayFulfillmentStatus:
   * UNFULFILLED / IN_PROGRESS / FULFILLED / ON_HOLD …). Drives the return gate:
   * an order that never shipped has no parcel to wait for (cancel-before-ship
   * refunds proceed directly), ON_HOLD goes to a human. Absent → the guard
   * falls back to the plain returnable-physical rule.
   */
  fulfillment_status?: string;

  /** Dodo subscription behind a plan_change claim — required for that action. */
  subscription_id?: string;
  /**
   * Product id the customer wants to move to. Known ahead of the brain's
   * decision (same shape as payment_id for refunds) — the ticket/conversation
   * carries which plan was asked for, the agents only decide whether to grant it.
   */
  requested_product_id?: string;

  /**
   * Whether there is a parcel in the world at all. Note this is NOT the same as
   * "returnable" — a perishable, an opened hygiene item or a custom-made piece
   * is physical but never comes back. Returnability is carried by return_status
   * ("not_required"), so the gate keys off the pair, not off this field alone.
   */
  item_type: "physical" | "digital";
  /**
   * Where the product is, and whether a return is owed at all.
   *
   * "not_required" means NOTHING has to come back — either it's digital, or it's
   * a non-returnable physical item (perishable, opened hygiene, custom-made,
   * final sale). It is the "skip the return gate" status. Deliberately distinct
   * from "not_started", which means a return IS owed and hasn't been raised yet:
   * collapsing the two would hold a refund forever on a parcel that can never
   * arrive.
   *
   * The truth comes from the RMA store (a warehouse scan) or the ticket body —
   * never from the customer's word in the conversation.
   */
  return_status: "not_required" | "not_started" | "requested" | "completed";
  /**
   * When the customer got the item, ISO date. The return window runs from here,
   * not from the purchase. Absent → the window can't be applied (the guard does
   * not deny for missing data, it just can't enforce the deadline).
   */
  delivered_at?: string;
  /** Per-product return window in days; falls back to RETURN_WINDOW_DAYS (14). */
  return_window_days?: number;

  customer_history: {
    tenure_months: number;
    prior_refunds: number;
    prior_tickets: number;
  };
  resolution_confidence: number; // 0–1, from the Resolution agent
}

export interface GuardVerdict {
  decision: "approve" | "deny";
  reason: string;
  hard_check_failed?: string; // which hard check tripped: unverified | auto_limit | no_payment | awaiting_return
}

export interface ResolutionProposal {
  action: "refund" | "plan_change" | "escalate" | "refuse";
  facts: CaseFacts;
  summary: string; // one line for the ops view / Freshdesk note
}
