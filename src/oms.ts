// The order seam — same idea as helpdesk.ts and payments.ts, for order truth.
//
// A refund decision needs two different things from two different systems:
// the COMPLAINT (why the customer is unhappy) and the ORDER (what was bought,
// for how much, when it was delivered, whether it can come back). The helpdesk
// owns the first. This owns the second.
//
// Keeping them apart is not tidiness, it is the security property. A ticket body
// is customer-supplied text; an order record is a system of record the caller
// cannot write to. When the facts were parsed out of the ticket, anything that
// could get text into the body could in principle move the numbers the guard
// judges. Now the ticket supplies exactly one thing — an order id — and every
// field the guard reads comes from here.
//
//   OMS=local   → data/orders.json (the default and the demo path)
//   OMS=shopify → Shopify Admin GraphQL API, read-only (integrations/shopify.ts)
//
// Adding another platform means a module satisfying OrderSource plus a line in
// getOrderSource(). Read integrations/shopify.ts before claiming coverage: it
// supplies the item, amount and fulfilment state, and documents field by field
// what it CANNOT supply (customer tenure, prior refunds, per-product return
// policy). Those stay seeded, and the header there says so.
//
// One deliberate boundary, mirroring createTicket in helpdesk.ts: writing orders
// is NOT part of this interface. Only the seed scripts create orders, and they
// are allowed to be implementation-specific.

import { localOrderSource } from "./integrations/order-store.js";
import { shopifyOrderSource } from "./integrations/shopify.js";

/**
 * One order as an order-management system would hold it.
 *
 * `returnable` is a product-policy flag, NOT a restatement of item_type: a
 * perishable, an opened hygiene item and a custom-made piece are all physical
 * and none of them can come back (types.ts, item_type). A boolean here is the
 * point — the old ticket-body wording had to be interpreted, and "not
 * applicable" vs "not requested" are opposite meanings that read alike.
 *
 * Return PROGRESS is deliberately absent. Where the parcel actually is belongs
 * to the warehouse (returns.ts, the RMA store), which the guard re-reads at
 * decision time anyway.
 */
export interface OrderRecord {
  order_id: string;
  item: string;
  item_type: "physical" | "digital";
  returnable: boolean;
  /** Per-product window in days; absent → the RETURN_WINDOW_DAYS default. */
  return_window_days?: number;
  amount_minor: number; // paise
  currency: string;
  /** "₹1,499" — what the agent says out loud, so narration never re-derives it. */
  amount_narrated: string;
  /** The PSP charge behind the order. Absent → nothing to refund. */
  payment_id?: string;
  /** ISO date the customer received it. The return window runs from here. */
  delivered_at?: string;
  customer: {
    email: string;
    name?: string;
    /** ISO date the account was opened — tenure is derived, never stored stale. */
    since?: string;
    prior_refunds: number;
  };
}

export interface OrderSource {
  /** Which implementation is live — shown on the ops view. */
  name: "local" | "shopify";
  /** False when the backing store is missing — callers degrade instead of throwing. */
  configured(): boolean;
  /** Undefined when the id is unknown, which the caller treats as incomplete facts. */
  getOrder(orderId: string): Promise<OrderRecord | undefined>;
}

export function getOrderSource(): OrderSource {
  const choice = (process.env.OMS ?? "local").toLowerCase();
  if (choice === "shopify") {
    // Falling back rather than throwing is deliberate: a half-configured
    // Shopify app mid-demo should degrade to the seeded orders that always
    // work, not take the whole flow down. The warning names the cause.
    if (shopifyOrderSource.configured()) return shopifyOrderSource;
    console.warn("OMS=shopify but SHOPIFY_STORE_DOMAIN/CLIENT_ID/CLIENT_SECRET are incomplete — falling back to local");
    return localOrderSource;
  }
  if (choice !== "local") {
    console.warn(`Unknown OMS="${choice}" — falling back to local`);
  }
  return localOrderSource;
}
