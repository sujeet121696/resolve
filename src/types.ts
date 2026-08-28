// Shared contracts. The most important one is CaseFacts — the ONLY thing the
// Policy-Guard ever sees (DESIGN.md decision 4: structured fields, never transcript).

export interface CaseFacts {
  ticket_id: string;
  order_id: string;
  amount: number; // minor units (cents/paise)
  currency: string;
  payment_id?: string; // Dodo payment behind the order — required for refund actions

  claim_type: "refund" | "plan_change" | "other";

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
