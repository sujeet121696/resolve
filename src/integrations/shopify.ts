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
//                       store would report zero tenure.
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

interface ShopifyOrder {
  name: string;
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
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(minorUnits / 100);
}

function toOrderRecord(orderId: string, node: ShopifyOrder): OrderRecord {
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
    delivered_at: node.fulfillments[0]?.createdAt?.slice(0, 10),
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

/** This module as an OrderSource — what getOrderSource() hands the agents. */
export const shopifyOrderSource: OrderSource = {
  name: "shopify",
  configured: shopifyConfigured,
  getOrder,
};
