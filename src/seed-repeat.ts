// Repeat-ticket minting (`npm run seed:repeat`) — Step 7 consistency runs.
//
// Each live demo call resolves ONE ticket (idempotency is per-ticket), and
// get_context picks the customer's newest ticket. So every repeat run needs a
// fresh Ravi ticket bound to a fresh un-refunded payment. This script creates
// exactly one: next ORD number, newest un-refunded succeeded payment.
//
// Flow per repeat: pay a checkout link (4242…) → npm run seed:repeat → call.

import "dotenv/config";
import { dodoClient } from "./integrations/dodo.js";
import { createTicket, freshdeskConfigured, listTicketsByEmail } from "./integrations/freshdesk.js";
import { putOrder } from "./integrations/order-store.js";
import { seedReceivedReturn } from "./returns.js";

const EMAIL = "ravi.test@example.com";
const NAME = "Ravi Kumar";

// Earbuds are a physical item, so the guard holds the refund until the parcel is
// back (policy-guard.ts, awaiting_return). Two flavours of repeat ticket:
//   default      → nothing returned yet: the agent arranges the return pickup
//   --returned   → parcel already collected: the refund is approved and fires
// Both are worth demoing; --returned is the one that moves money.
// Earbuds are a physical item, so the guard holds the refund until the parcel is
// back (policy-guard.ts, awaiting_return) and only within the return window.
//   default      → delivered 3 days ago, nothing returned: agent arranges pickup
//   --returned   → parcel already collected: refund approved and fires
//   --expired    → delivered 40 days ago: outside the 14-day window → human
const RETURNED = process.argv.includes("--returned");
const EXPIRED = process.argv.includes("--expired");

const RETURN_WINDOW_DAYS = 14;
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const deliveredAt = daysAgo(EXPIRED ? 40 : 3);

if (!freshdeskConfigured()) {
  console.error("FRESHDESK_DOMAIN / FRESHDESK_API_KEY not set.");
  process.exit(1);
}

// Newest un-refunded succeeded payment, not already burned by an earlier
// ticket (each existing ticket body references its payment id).
const dodo = dodoClient();
const tickets = await listTicketsByEmail(EMAIL);

const candidates: string[] = [];
for await (const p of dodo.payments.list({ status: "succeeded", page_size: 100 })) {
  if (p.customer.email === EMAIL && !p.refund_status) candidates.push(p.payment_id);
}
if (candidates.length === 0) {
  console.error("No un-refunded succeeded payment for Ravi — pay a checkout link first (card 4242 4242 4242 4242).");
  process.exit(1);
}
const paymentId = candidates[0]!;

// Next ORD number after the highest existing one.
let maxOrd = 1103;
for (const t of tickets) {
  const m = t.subject.match(/ORD-(\d+)/);
  if (m) maxOrd = Math.max(maxOrd, Number(m[1]));
}
const orderId = `ORD-${maxOrd + 1}`;

// The ticket is the complaint only — an order number and why he's unhappy, the
// way a customer writes it. Every fact the guard judges goes to the order
// source, which the customer cannot write to (oms.ts).
const ticket = await createTicket({
  subject: `Refund request — Wireless Earbuds stopped charging (${orderId})`,
  descriptionHtml: `
    <p>My wireless earbuds stopped holding a charge after two days of use
    (order ${orderId}).
    ${RETURNED
      ? "I have already returned them — the courier collected the parcel and it has been scanned in at your warehouse. Please refund my payment."
      : "I would like a refund for this order please."}</p>`,
  email: EMAIL,
  name: NAME,
  priority: 2,
  tags: ["resolve-demo"],
});

putOrder({
  order_id: orderId,
  item: "Wireless Earbuds",
  item_type: "physical",
  returnable: true,
  return_window_days: RETURN_WINDOW_DAYS,
  amount_minor: 149900,
  currency: "INR",
  amount_narrated: "₹1,499",
  payment_id: paymentId,
  delivered_at: deliveredAt,
  customer: { email: EMAIL, name: NAME, since: "2024-03-11", prior_refunds: 1 },
});

// --returned means the parcel was back BEFORE he wrote in, which is a warehouse
// fact, not something his message can assert (returns.ts).
if (RETURNED) {
  const rma = seedReceivedReturn(orderId, String(ticket.id));
  console.log(`return ${rma.rma} pre-marked received for ${orderId}`);
}

console.log(`ticket created: #${ticket.id} ${orderId} → payment ${paymentId}`);
console.log(`order record written: ${orderId} · ₹1,499 · delivered ${deliveredAt}`);
console.log(
  RETURNED
    ? "Return marked completed — a call on this ticket will get the refund APPROVED (money moves)."
    : EXPIRED
      ? `Delivered ${deliveredAt} (40 days ago) — outside the ${RETURN_WINDOW_DAYS}-day window, so a call will ESCALATE TO A HUMAN, not arrange a pickup.`
      : `Delivered ${deliveredAt}, return not requested — a call will ARRANGE THE RETURN, not refund. Use --returned for the refund take.`,
);
console.log("Ready for a live call: Ravi's newest ticket now points at a fresh payment.");
