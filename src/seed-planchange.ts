// Plan-change ticket minting (`npm run seed:planchange`) — Stage 2 build item #1.
//
// Mirrors seed-repeat.ts's shape for the refund scenario, but a subscription
// can't be minted headless: Dodo has no auto-succeed API in test mode
// (DODO-SETUP.md), so the first run always needs one manual checkout.
//
// Flow: first run prints a checkout link → pay it by hand (4242…) → re-run
// this script → ticket + order record ready for a live call. Re-runs after
// that reuse the same subscription (idempotent by customer+product), so this
// is also the rehearsal-reset script: it just points a fresh ticket at
// whatever plan Meera is actually on right now.
//
// Every fact the guard judges comes from the order record below (oms.ts),
// which the ticket text cannot write to — same boundary as the refund seed.

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { dodoClient } from "./integrations/dodo.js";
import { createTicket, freshdeskConfigured } from "./integrations/freshdesk.js";
import { putOrder } from "./integrations/order-store.js";

const EMAIL = "meera.test@example.com";
const NAME = "Meera Nair";

const BASIC_NAME = "Resolve Demo — Basic Plan";
const PRO_NAME = "Resolve Demo — Pro Plan";
const BASIC_PRICE = 1000; // $10.00/mo
const PRO_PRICE = 2500; // $25.00/mo

if (!freshdeskConfigured()) {
  console.error("FRESHDESK_DOMAIN / FRESHDESK_API_KEY not set.");
  process.exit(1);
}

const dodo = dodoClient();

/** Idempotent by name — reuse the product if a prior run already created it. */
async function ensureProduct(name: string, price: number): Promise<string> {
  for await (const p of dodo.products.list()) {
    if (p.name === name) return p.product_id;
  }
  const created = await dodo.products.create({
    name,
    tax_category: "digital_products",
    price: {
      type: "recurring_price",
      currency: "USD",
      price,
      discount: 0,
      purchasing_power_parity: false,
      payment_frequency_count: 1,
      payment_frequency_interval: "Month",
      subscription_period_count: 1,
      subscription_period_interval: "Month",
      tax_inclusive: true,
    },
  });
  console.log(`created product ${name} → ${created.product_id}`);
  return created.product_id;
}

const basicId = await ensureProduct(BASIC_NAME, BASIC_PRICE);
const proId = await ensureProduct(PRO_NAME, PRO_PRICE);

// Meera's active Basic subscription, if one already exists from a prior run.
let subscriptionId: string | undefined;
for await (const s of dodo.subscriptions.list({ status: "active", product_id: basicId })) {
  if (s.customer.email === EMAIL) {
    subscriptionId = s.subscription_id;
    break;
  }
}

if (!subscriptionId) {
  const sub = await dodo.subscriptions.create({
    product_id: basicId,
    quantity: 1,
    billing: { country: "US" },
    customer: { email: EMAIL, name: NAME },
    payment_link: true,
  });
  console.log();
  console.log("No active Basic subscription for Meera yet — pay this checkout link, then re-run this script:");
  console.log(sub.payment_link);
  console.log("Card: 4242 4242 4242 4242, any future expiry/CVC, any billing ZIP.");
  process.exit(0);
}

// Order id must match ORD-<digits> — case-context.ts's regex only recognizes
// that shape when it scans the ticket subject (a "SUB-..." id silently fails
// to match, which is exactly the bug this comment is here to stop someone
// reintroducing). Next number after the highest ORD- id already on file.
let maxOrd = 1103;
try {
  const orders: Record<string, { order_id: string }> = JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), "data", "orders.json"), "utf8"),
  );
  for (const id of Object.keys(orders)) {
    const m = id.match(/^ORD-(\d+)$/);
    if (m) maxOrd = Math.max(maxOrd, Number(m[1]));
  }
} catch {
  // No orders.json yet — start from the same floor seed-repeat.ts uses.
}
const orderId = `ORD-${maxOrd + 1}`;

// Ticket is the complaint only — an order number and why she's writing in, the
// way a customer phrases it. The plan/subscription facts live in the order
// record (oms.ts), which she cannot write to.
const ticket = await createTicket({
  subject: `Upgrade request — moving to the Pro plan (${orderId})`,
  descriptionHtml: `<p>I'd like to upgrade my subscription to the Pro plan, please (${orderId}).</p>`,
  email: EMAIL,
  name: NAME,
  priority: 2,
  tags: ["resolve-demo"],
});

putOrder({
  order_id: orderId,
  item: "Resolve Demo — Basic Plan subscription",
  item_type: "digital",
  returnable: false,
  amount_minor: BASIC_PRICE,
  currency: "USD",
  amount_narrated: "$10.00/mo (current plan)",
  subscription_id: subscriptionId,
  requested_product_id: proId,
  customer: { email: EMAIL, name: NAME, since: "2025-01-15", prior_refunds: 0 },
});

console.log(`ticket created: #${ticket.id} ${orderId} → subscription ${subscriptionId}`);
console.log(`order record written: ${orderId} → requesting upgrade to Pro (${proId})`);
console.log("Ready for a live call: Meera's ticket points at her real Basic subscription, requesting Pro.");
