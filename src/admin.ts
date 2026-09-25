// Admin/demo-setup helpers — mint a Dodo test payment and create the matching
// Freshdesk ticket for a new test scenario in one place, instead of one-off
// scripts. Local demo tooling only: no auth, same trust level as /chat and
// /events. Shopify order creation stays manual (read_orders-only scope,
// deliberately — see integrations/shopify.ts) — this only speeds up the two
// pieces that genuinely can be automated.

import express from "express";
import { dodoClient } from "./integrations/dodo.js";
import { createTicket } from "./integrations/freshdesk.js";
import { lookupContext } from "./case-context.js";

export const admin = express.Router();

// Known demo catalog — reused across tonight's scenarios, kept here instead
// of re-discovering ids from the Dodo dashboard each time.
const PRODUCTS = [
  { id: "pdt_0NlsIsmqBrc1uB1xu8Rmb", name: "Wireless Earbuds — $17.99" },
  { id: "pdt_0NlsIsoRuZGCnOdTcvf1B", name: "Premium Annual Plan — $228.99 (over the $50 auto-limit)" },
  { id: "pdt_0NnbpuV4BVnunBUwSz8pD", name: "Pro Plan — $25.00" },
  { id: "pdt_0NnbpuSsCFnDyneRHixSr", name: "Basic Plan — $10.00" },
  { id: "pdt_0NlnIqPT45L04T8yxmsYz", name: "Test Phone — $10.99" },
];

const CUSTOMERS = [
  { id: "cus_0NnneF9eWBlwLevTSSfxM", email: "sujeet6623@gmail.com" },
  { id: "cus_0NnndTiKBQgOpAVBWqOX0", email: "priya@example.com" },
  { id: "cus_0NnndTgL1j8P6QDoCFtN9", email: "ravi@example.com" },
  { id: "cus_0NneAU1mLdx1RZlpCOFKB", email: "meera@example.com" },
];

admin.get("/catalog", (_req, res) => res.json({ products: PRODUCTS, customers: CUSTOMERS }));

admin.post("/mint-payment", async (req, res) => {
  const { productId, customerId, quantity } = req.body ?? {};
  if (!productId || !customerId) return res.status(400).json({ error: "productId and customerId required" });
  try {
    const dodo = dodoClient();
    const payment = await dodo.payments.create({
      billing: { country: "US", city: "San Francisco", state: "CA", street: "1 Demo St", zipcode: "94105" },
      customer: { customer_id: customerId },
      product_cart: [{ product_id: productId, quantity: Number(quantity) || 1 }],
      payment_link: true,
      metadata: { seeded_by: "resolve-admin-ui" },
    });
    res.json({ payment_id: payment.payment_id, payment_link: payment.payment_link });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

admin.post("/create-ticket", async (req, res) => {
  const { orderNumber, email, name } = req.body ?? {};
  if (!orderNumber || !email) return res.status(400).json({ error: "orderNumber and email required" });
  try {
    const ticket = await createTicket({
      subject: `Refund request for order ORD-${orderNumber}`,
      descriptionHtml: `Customer requesting a refund for order ORD-${orderNumber}.`,
      email,
      name: name || email,
    });
    res.json({ ticket_id: ticket.id });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Same lookup the voice agent uses — lets you confirm a scenario resolves
// correctly before ever picking up the phone.
admin.post("/verify-context", async (req, res) => {
  const { email } = req.body ?? {};
  if (!email) return res.status(400).json({ error: "email required" });
  try {
    res.json(await lookupContext(`admin-verify-${Date.now()}`, email));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
