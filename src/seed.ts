// Seed script (`npm run seed`) — creates the demo world.
//
// Dodo half (works now): products + customers + payment links for the two
// scenarios. Test mode has no "auto-succeed" — each printed link must be opened
// once and paid with test card 4242 4242 4242 4242 (any future expiry/CVC).
// That single manual pass is what puts SUCCEEDED payments in the dashboard for
// the agent to refund. Amounts are USD (test mode rejects INR — SPIKES.md);
// the demo narrates ₹ with a dual label (DESIGN.md decision 2).
//
// Freshdesk half (waits for the account): Ravi + Priya complaint tickets, with
// the order facts written to the order source rather than into the ticket body.
// Skipped with a notice until FRESHDESK_API_KEY is set.

import "dotenv/config";
import type { OrderRecord } from "./oms.js";
import { dodoClient } from "./integrations/dodo.js";
import { createTicket, freshdeskConfigured, listTicketsByEmail } from "./integrations/freshdesk.js";
import { putOrder } from "./integrations/order-store.js";
import { getOrderSource } from "./oms.js";
import { seedReceivedReturn } from "./returns.js";

// ₹1,499 ≈ $17.99 · ₹18,999 ≈ $228.99 (minor units)
const PRODUCTS = [
  { name: "Resolve Demo — Wireless Earbuds", price: 1799, narrated: "₹1,499" },
  { name: "Resolve Demo — Premium Annual Plan", price: 22899, narrated: "₹18,999" },
] as const;

const CUSTOMERS = [
  { name: "Ravi Kumar", email: "ravi.test@example.com" },
  { name: "Priya Sharma", email: "priya.test@example.com" },
  { name: "Arjun Iyer", email: "arjun.test@example.com" },
] as const;

// Several Ravi payments: test-mode fees drain the wallet, and Steps 4/7/9 each
// burn a refundable payment. One Priya payment (her refund gets DENIED anyway).
const PAYMENT_PLAN: { customerEmail: string; productName: string; count: number }[] = [
  // Ravi's scenario refunds a payment permanently on every run, so his stock is
  // one-run-one-payment: rehearsals on chat and takes on voice both consume one.
  // 10 covers a practice session plus retakes. Priya's case is denied at the
  // auto-limit and never consumes hers, so 1 is enough for her forever.
  { customerEmail: "ravi.test@example.com", productName: "Resolve Demo — Wireless Earbuds", count: 10 },
  { customerEmail: "priya.test@example.com", productName: "Resolve Demo — Premium Annual Plan", count: 1 },
  { customerEmail: "arjun.test@example.com", productName: "Resolve Demo — Wireless Earbuds", count: 1 },
];

async function seedDodo() {
  const dodo = dodoClient();
  console.log("── Dodo (test mode) ──");

  // Products: find by name, create if missing.
  const productIds = new Map<string, string>();
  for await (const p of dodo.products.list({ page_size: 100 })) {
    if (p.name) productIds.set(p.name, p.product_id);
  }
  for (const spec of PRODUCTS) {
    let id = productIds.get(spec.name);
    if (id) {
      console.log(`  product exists: ${spec.name} (${id})`);
    } else {
      const created = await dodo.products.create({
        name: spec.name,
        tax_category: "digital_products",
        price: {
          type: "one_time_price",
          currency: "USD",
          price: spec.price,
          discount: 0,
          purchasing_power_parity: false,
          tax_inclusive: true,
        },
      });
      id = created.product_id;
      productIds.set(spec.name, id);
      console.log(`  product created: ${spec.name} → ${id} ($${(spec.price / 100).toFixed(2)} ≈ ${spec.narrated})`);
    }
  }

  // Customers: find by email, create if missing.
  const customerIds = new Map<string, string>();
  for await (const c of dodo.customers.list({ page_size: 100 })) {
    customerIds.set(c.email, c.customer_id);
  }
  for (const spec of CUSTOMERS) {
    let id = customerIds.get(spec.email);
    if (id) {
      console.log(`  customer exists: ${spec.name} (${id})`);
    } else {
      const created = await dodo.customers.create({ name: spec.name, email: spec.email });
      id = created.customer_id;
      customerIds.set(spec.email, id);
      console.log(`  customer created: ${spec.name} → ${id}`);
    }
  }

  // Payment links — the manual checkout pass. Top-up only: count each
  // customer's existing un-refunded succeeded payments and mint links just for
  // the deficit, so re-running the seed stops raining fresh links.
  const unrefunded = new Map<string, number>();
  for await (const p of dodo.payments.list({ status: "succeeded", page_size: 100 })) {
    if (!p.refund_status) unrefunded.set(p.customer.email, (unrefunded.get(p.customer.email) ?? 0) + 1);
  }

  console.log("\n── Payment links (open each, pay with 4242 4242 4242 4242) ──");
  const links: string[] = [];
  for (const item of PAYMENT_PLAN) {
    const customerId = customerIds.get(item.customerEmail)!;
    const productId = productIds.get(item.productName)!;
    const have = unrefunded.get(item.customerEmail) ?? 0;
    const deficit = Math.max(0, item.count - have);
    if (deficit === 0) {
      console.log(`  ${item.customerEmail}: ${have} un-refunded payment(s) on hand — no new links.`);
      continue;
    }
    for (let i = 0; i < deficit; i++) {
      const payment = await dodo.payments.create({
        billing: { country: "US", city: "San Francisco", state: "CA", street: "1 Demo St", zipcode: "94105" },
        customer: { customer_id: customerId },
        product_cart: [{ product_id: productId, quantity: 1 }],
        payment_link: true,
        metadata: { seeded_by: "resolve-seed", scenario: item.customerEmail.split(".")[0] ?? "" },
      });
      links.push(payment.payment_link ?? "(no link returned)");
      console.log(`  ${item.customerEmail} · ${item.productName} → ${payment.payment_link}`);
    }
  }
  if (links.length > 0) {
    console.log(`\n  ${links.length} links created. Card: 4242 4242 4242 4242 · any future expiry · any CVC.`);
    console.log("  After paying, verify: succeeded payments appear in the Dodo test dashboard.");
  } else {
    console.log("  Nothing to mint — every scenario has enough un-refunded payments.");
  }
}

// Scenario tickets + the order records behind them.
//
// The ticket body is what a customer would actually write: a complaint and an
// order number, nothing else. Every fact the guard judges lives in the order
// source instead (oms.ts), because a ticket body is customer-supplied text and
// an order record is not. payment_id is bound live from Dodo — the customer's
// newest succeeded, un-refunded payment.
//
// Delivery dates are relative so the 14-day return window stays meaningful
// whenever the seed is run (policy-guard.ts, return_window_expired).
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

interface TicketSpec {
  email: string;
  name: string;
  orderId: string;
  subject: string;
  priority: 1 | 2 | 3 | 4;
  body: string;
  /** Everything except order_id, payment_id and the customer email/name. */
  order: Omit<OrderRecord, "order_id" | "payment_id" | "customer">;
  since: string;
  priorRefunds: number;
  /** Parcel already back before the customer wrote in (RMA store, not prose). */
  returnReceived?: boolean;
}

const EARBUDS = {
  item: "Wireless Earbuds",
  item_type: "physical",
  returnable: true,
  return_window_days: 14,
  amount_minor: 149900,
  currency: "INR",
  amount_narrated: "₹1,499",
} as const;

const TICKETS: TicketSpec[] = [
  {
    email: "ravi.test@example.com",
    name: "Ravi Kumar",
    orderId: "ORD-1101",
    subject: "Refund request — Wireless Earbuds arrived damaged (ORD-1101)",
    priority: 2,
    body: `
      <p>Hi, I received my wireless earbuds today and the right earbud does not charge.
      The case also has a crack. Order ORD-1101. I would like a refund please.</p>`,
    order: { ...EARBUDS, delivered_at: daysAgo(4) },
    since: "2024-03-11",
    priorRefunds: 0,
  },
  {
    // Step 7 demo ticket — Ravi's SECOND order. get_context picks the newest
    // ticket, so a live call lands here and the refund fires on a fresh payment.
    email: "ravi.test@example.com",
    name: "Ravi Kumar",
    orderId: "ORD-1103",
    subject: "Refund request — Wireless Earbuds, wrong colour delivered (ORD-1103)",
    priority: 2,
    body: `
      <p>I ordered the black wireless earbuds but received a white pair instead
      (order ORD-1103). I already returned the item at the pickup point.
      Please refund my payment.</p>`,
    order: { ...EARBUDS, delivered_at: daysAgo(6) },
    since: "2024-03-11",
    priorRefunds: 1,
    returnReceived: true,
  },
  {
    email: "priya.test@example.com",
    name: "Priya Sharma",
    orderId: "ORD-2102",
    subject: "Refund request — Premium Annual Plan (ORD-2102)",
    priority: 3,
    body: `
      <p>I purchased the Premium Annual Plan last week (ORD-2102) but my team decided
      to go with a different tool. I want a full refund of the plan.</p>`,
    order: {
      item: "Premium Annual Plan",
      item_type: "digital",
      returnable: false, // nothing ships, so nothing can come back
      amount_minor: 1899900,
      currency: "INR",
      amount_narrated: "₹18,999",
    },
    since: daysAgo(92), // ~3 months' tenure, computed so it stays true over time
    priorRefunds: 2,
  },
];

async function seedFreshdesk() {
  console.log("\n── Freshdesk ──");
  if (!freshdeskConfigured()) {
    console.log("  skipped — FRESHDESK_DOMAIN / FRESHDESK_API_KEY not set yet.");
    return;
  }

  // Live payment lookup: newest succeeded, un-refunded payment per customer.
  const dodo = dodoClient();
  const paymentByEmail = new Map<string, string>();
  for await (const p of dodo.payments.list({ status: "succeeded", page_size: 100 })) {
    const email = p.customer.email;
    if (!p.refund_status && !paymentByEmail.has(email)) {
      paymentByEmail.set(email, p.payment_id);
    }
  }

  const orders = getOrderSource();

  for (const t of TICKETS) {
    const existing = await listTicketsByEmail(t.email);
    const dupe = existing.find((e) => e.subject.includes(t.orderId));
    // Both halves must exist. A ticket without its order record is the one state
    // worth repairing on a re-run: data/orders.json is local and easy to lose,
    // and the ticket alone can no longer be resolved.
    if (dupe && (await orders.getOrder(t.orderId))) {
      console.log(`  ticket + order exist: #${dupe.id} ${t.orderId}`);
      continue;
    }
    const paymentId = paymentByEmail.get(t.email);
    if (!paymentId) {
      console.log(`  SKIPPED ${t.name}: no un-refunded succeeded payment in Dodo — run the checkout pass first.`);
      continue;
    }

    let ticketId: number;
    if (dupe) {
      ticketId = dupe.id;
      console.log(`  ticket exists: #${ticketId} — backfilling the missing order record`);
    } else {
      const ticket = await createTicket({
        subject: t.subject,
        descriptionHtml: t.body,
        email: t.email,
        name: t.name,
        priority: t.priority,
        tags: ["resolve-demo"],
      });
      ticketId = ticket.id;
      console.log(`  ticket created: #${ticketId} ${t.subject}`);
    }

    putOrder({
      ...t.order,
      order_id: t.orderId,
      payment_id: paymentId,
      customer: { email: t.email, name: t.name, since: t.since, prior_refunds: t.priorRefunds },
    });
    console.log(`    order ${t.orderId} → ${t.order.amount_narrated}, payment ${paymentId}`);

    if (t.returnReceived) {
      const rma = seedReceivedReturn(t.orderId, String(ticketId));
      console.log(`    return ${rma.rma} pre-marked received (parcel was already back)`);
    }
  }
}

await seedDodo();
await seedFreshdesk();
console.log("\nSeed complete.");
