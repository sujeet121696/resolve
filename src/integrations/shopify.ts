// Shopify Admin API as an OrderSource — read-only, GraphQL, one order at a time.
//
// What this genuinely supplies, off a real order in a real store: the item, the
// amount, the currency, and whether the parcel has shipped.
//
// What it CANNOT supply, and where those values really come from. Read this
// before describing Resolve as "integrated with Shopify":
//
//   payment_id          The charge is a DODO charge; Shopify has never seen it.
//                       A real OMS keeps the PSP reference on the order, so we
//                       do the same in the order's Note: `dodo_payment_id: …`.
//                       No note → no payment_id → the guard's no_payment check
//                       routes the case to a human. That is the correct failure,
//                       not a workaround.
//   returnable,         Per-product return policy lives on product tags or
//   return_window_days  metafields, which needs read_products. We request
//                       read_orders only, so a physical item defaults to
//                       returnable on the store-wide RETURN_WINDOW_DAYS window.
//   customer.*          Email, account age and refund history are Shopify
//                       protected customer data, which we deliberately do not
//                       request. The email the flow uses comes from the helpdesk
//                       requester (case-context.ts); tenure and prior refunds
//                       read as 0. Shopify also cannot backdate
//                       customer.createdAt, so even WITH the scope a fresh dev
//                       store would report zero tenure. The one exception is
//                       verifyOwnership below, which FILTERS the order search
//                       by email without ever reading a customer field.
//
// Auth is the client_credentials grant: client id + secret are exchanged for a
// 24-hour access token, cached in memory only. No long-lived token is stored.
// The grant works only when the app and the store are in the same Shopify org.
//
// Dev stores cannot process real transactions — which is precisely why money
// stays on Dodo test mode. Shopify is the order system of record here, nothing
// more, and the refund rail is untouched by this file.

// Type-only import: the contract lives in the seam, so there is no runtime cycle
// between oms.ts and this module (same shape as freshdesk.ts).
import type { OrderRecord, OrderSource } from "../oms.js";
import { neverShipped } from "../types.js";

const DOMAIN = () => process.env.SHOPIFY_STORE_DOMAIN;
const CLIENT_ID = () => process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = () => process.env.SHOPIFY_CLIENT_SECRET;
const API_VERSION = () => process.env.SHOPIFY_API_VERSION ?? "2026-07";

export function shopifyConfigured(): boolean {
  return Boolean(DOMAIN() && CLIENT_ID() && CLIENT_SECRET());
}

// --- Auth -------------------------------------------------------------------

/** Refresh this far before expiry so a call never races the boundary. */
const REFRESH_MARGIN_MS = 60_000;

let cachedToken: { token: string; expiresAt: number } | undefined;

async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt - Date.now() > REFRESH_MARGIN_MS) {
    return cachedToken.token;
  }
  if (!shopifyConfigured()) {
    throw new Error("Shopify not configured (SHOPIFY_STORE_DOMAIN / SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET)");
  }
  const res = await fetch(`https://${DOMAIN()}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: CLIENT_ID()!,
      client_secret: CLIENT_SECRET()!,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Shopify token exchange → ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    token: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
  return cachedToken.token;
}

// --- Transport ---------------------------------------------------------------

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const token = await accessToken();
  const res = await fetch(`https://${DOMAIN()}/admin/api/${API_VERSION()}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Shopify GraphQL → ${res.status}: ${body.slice(0, 300)}`);
  }
  // GraphQL returns 200 with an errors array, so status alone proves nothing.
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length) {
    throw new Error(`Shopify GraphQL: ${json.errors.map((e) => e.message).join("; ")}`);
  }
  if (!json.data) throw new Error("Shopify GraphQL returned no data");
  return json.data;
}

// --- Mapping -----------------------------------------------------------------

export interface ShopifyOrder {
  name: string;
  /** When the order was placed — the fallback start of the return window. */
  createdAt: string;
  /** UNFULFILLED / IN_PROGRESS / FULFILLED / ON_HOLD … — drives the return gate. */
  displayFulfillmentStatus: string;
  note: string | null;
  currentTotalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  fulfillments: { createdAt: string }[];
  lineItems: { nodes: { title: string; requiresShipping: boolean }[] };
}

// Only the fields we can read with read_orders alone. Nothing customer-related
// is requested — see the header. `first: 2` so an ambiguous match is detectable
// rather than silently resolved to whichever order came back first.
const ORDER_QUERY = `
  query orderByName($q: String!) {
    orders(first: 2, query: $q) {
      nodes {
        name
        createdAt
        displayFulfillmentStatus
        note
        currentTotalPriceSet { shopMoney { amount currencyCode } }
        fulfillments(first: 1) { createdAt }
        lineItems(first: 1) { nodes { title requiresShipping } }
      }
    }
  }
`;

/** The PSP reference an order record would normally carry. See the header. */
const PAYMENT_NOTE_RE = /dodo_payment_id\s*[:=]\s*([A-Za-z0-9_-]+)/i;

/**
 * Shopify returns decimal strings ("1499.00"). INR and USD both have two
 * decimal places; a zero-decimal currency such as JPY would need a lookup table
 * here, and this would over-report by 100x. Not a problem we have, but it is a
 * limit of this line and not a general money converter.
 */
function toMinorUnits(amount: string): number {
  return Math.round(Number(amount) * 100);
}

function narrate(minorUnits: number, currency: string): string {
  // Whole amounts read as "₹1,499"; amounts with cents keep them ("$14.99").
  // Rounding everything to whole units narrated a $14.99 order as "$15" — a
  // wrong number said out loud by an agent that is supposed to never invent one.
  const whole = minorUnits % 100 === 0;
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency,
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).format(minorUnits / 100);
}

export function toOrderRecord(orderId: string, node: ShopifyOrder): OrderRecord {
  const money = node.currentTotalPriceSet.shopMoney;
  const amountMinor = toMinorUnits(money.amount);
  const line = node.lineItems.nodes[0];
  // requiresShipping is the honest physical/digital signal on an order: a plan
  // or download never ships. It needs no extra scope and no naming convention.
  const itemType = line?.requiresShipping ? "physical" : "digital";

  return {
    // The id the TICKET used, not Shopify's order name. Everything downstream
    // is keyed on it — the RMA store, idempotency, the ops view — so handing
    // back a different string would silently split one case into two.
    order_id: orderId,
    item: line?.title ?? "your order",
    item_type: itemType,
    // See the header: per-product policy needs read_products, so physical
    // defaults to returnable and the window falls back to RETURN_WINDOW_DAYS.
    returnable: itemType === "physical",
    return_window_days: undefined,
    amount_minor: amountMinor,
    currency: money.currencyCode,
    amount_narrated: narrate(amountMinor, money.currencyCode),
    payment_id: node.note?.match(PAYMENT_NOTE_RE)?.[1],
    // Fulfilment is when it LEFT us, not when it arrived. A carrier-backed
    // integration would read the delivery event; this is the closest field a
    // read_orders scope has, and it makes the return window start slightly
    // early — the customer-favouring direction.
    //
    // Never shipped (UNFULFILLED / IN_PROGRESS) → NO delivery date at all:
    // nothing is with the customer, and inventing one from the order date made
    // the facts self-contradict ("unfulfilled" + "delivered") — a live case
    // escalated on exactly that. Any other state without a fulfilment falls
    // back to the ORDER date, so an old order can still expire the return
    // window (the cautious side: the window only starts earlier than delivery).
    delivered_at:
      node.fulfillments[0]?.createdAt?.slice(0, 10) ??
      (neverShipped(node.displayFulfillmentStatus) ? undefined : node.createdAt?.slice(0, 10)),
    fulfillment_status: node.displayFulfillmentStatus,
    customer: { email: "", prior_refunds: 0 },
  };
}

// --- The seam ----------------------------------------------------------------

async function getOrder(orderId: string): Promise<OrderRecord | undefined> {
  // Shopify names orders "#1001"; our tickets say "ORD-1101". Matching on the
  // digits alone means the adapter works whether or not the store sets an
  // order-id prefix — the number is the part both systems agree on.
  const digits = orderId.replace(/\D/g, "");
  if (!digits) return undefined;

  const data = await gql<{ orders: { nodes: ShopifyOrder[] } }>(ORDER_QUERY, {
    q: `name:${digits}`,
  });
  const nodes = data.orders.nodes;
  const node = nodes[0];
  if (!node) return undefined;
  if (nodes.length > 1) {
    console.warn(`Shopify: order number "${digits}" matched ${nodes.length} orders — using ${node.name}`);
  }
  return toOrderRecord(orderId, node);
}

// Ownership is asked as a SEARCH question, not a field read: the orders search
// index accepts an `email:` filter under read_orders alone (verified live
// Sept 25), and the response carries only the order name — so the customer's
// protected data is still never requested. One narrow yes/no: "is this order
// among this email's orders?"
const OWNERSHIP_QUERY = `
  query orderOwnership($q: String!) {
    orders(first: 1, query: $q) {
      nodes { name }
    }
  }
`;

async function verifyOwnership(
  orderId: string,
  email: string,
): Promise<"verified" | "mismatch" | "unknown"> {
  const digits = orderId.replace(/\D/g, "");
  const normalized = email.trim().toLowerCase();
  if (!digits || !normalized) return "unknown";
  try {
    const data = await gql<{ orders: { nodes: { name: string }[] } }>(OWNERSHIP_QUERY, {
      q: `name:${digits} AND email:${normalized}`,
    });
    return data.orders.nodes.length > 0 ? "verified" : "mismatch";
  } catch (err) {
    // Same degradation rule as getOrder: an API hiccup must read as "cannot
    // answer", never as an accusation of mismatch.
    console.warn(`Shopify ownership check failed for ${orderId}: ${(err as Error).message}`);
    return "unknown";
  }
}

// Same search index as verifyOwnership, sorted newest-first: "this email's
// latest order". Used only as the no-order-id fallback (case-context.ts), so
// the id is chosen by Shopify's records for the VERIFIED email — ownership by
// construction, and still no customer field read.
const LATEST_ORDER_QUERY = `
  query latestOrderForEmail($q: String!) {
    orders(first: 1, query: $q, sortKey: CREATED_AT, reverse: true) {
      nodes { name }
    }
  }
`;

async function latestOrderIdForEmail(email: string): Promise<string | undefined> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return undefined;
  try {
    const data = await gql<{ orders: { nodes: { name: string }[] } }>(LATEST_ORDER_QUERY, {
      q: `email:${normalized}`,
    });
    // "#1008" → "ORD-1008", the id convention every downstream store keys on.
    const digits = data.orders.nodes[0]?.name.replace(/\D/g, "");
    return digits ? `ORD-${digits}` : undefined;
  } catch (err) {
    console.warn(`Shopify latest-order lookup failed for ${normalized}: ${(err as Error).message}`);
    return undefined; // cannot answer → the caller degrades to no-order, never throws
  }
}

/** This module as an OrderSource — what getOrderSource() hands the agents. */
export const shopifyOrderSource: OrderSource = {
  name: "shopify",
  configured: shopifyConfigured,
  getOrder,
  verifyOwnership,
  latestOrderIdForEmail,
};
