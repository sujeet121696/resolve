// One Ravi ticket pointing at the SHOPIFY order #1001 — the per-repeat minting
// step for Shopify-path demos (RUNBOOK §10). Run AFTER updating the order's
// Note to a fresh FREE payment id.
//
// Unlike seed-repeat, this does NOT putOrder — the whole point is that the
// order facts (item, $14.99, payment note, fulfilment date) come from the live
// store through OMS=shopify. The RMA store is warehouse state, not order state,
// so pre-marking the return received stays local and legitimate.
import "dotenv/config";
import { createTicket, freshdeskConfigured } from "./integrations/freshdesk.js";
import { seedReceivedReturn } from "./returns.js";

const EMAIL = "ravi@example.com";
const ORDER_ID = "ORD-1001";

if (!freshdeskConfigured()) {
  console.error("FRESHDESK_DOMAIN / FRESHDESK_API_KEY not set.");
  process.exit(1);
}

const ticket = await createTicket({
  subject: `Refund request — Wireless Earbuds stopped charging (${ORDER_ID})`,
  descriptionHtml: `
    <p>My wireless earbuds stopped holding a charge after two days of use
    (order ${ORDER_ID}). I have already returned them — the courier collected
    the parcel and it has been scanned in at your warehouse. Please refund my
    payment.</p>`,
  email: EMAIL,
  name: "Ravi Kumar",
  priority: 2,
  tags: ["resolve-demo", "shopify-e2e"],
});

const rma = seedReceivedReturn(ORDER_ID, String(ticket.id));
console.log(`ticket created: #${ticket.id} → ${ORDER_ID} (Shopify order #1001)`);
console.log(`return ${rma.rma} pre-marked received for ${ORDER_ID}`);
console.log("Order facts will come from Shopify at get-context time.");
