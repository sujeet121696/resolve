import { test } from "node:test";
import assert from "node:assert/strict";
import { toOrderRecord, type ShopifyOrder } from "../integrations/shopify.js";

// Pure mapping tests — no network. The return-window rule itself lives in the
// guard (policy-guard.test.ts); this pins down what date the Shopify adapter
// hands it, because an order with no start date can never expire.

function order(over: Partial<ShopifyOrder> = {}): ShopifyOrder {
  return {
    name: "#1101",
    createdAt: "2026-08-01T10:00:00Z",
    note: "dodo_payment_id: pay_abc123",
    currentTotalPriceSet: { shopMoney: { amount: "1499.00", currencyCode: "INR" } },
    fulfillments: [],
    lineItems: { nodes: [{ title: "Wireless Earbuds", requiresShipping: true }] },
    ...over,
  };
}

test("an unfulfilled order falls back to its order date, so it can still expire", () => {
  const rec = toOrderRecord("ORD-1101", order());
  assert.equal(rec.delivered_at, "2026-08-01");
});

test("a fulfilment date wins over the order date", () => {
  const rec = toOrderRecord(
    "ORD-1101",
    order({ fulfillments: [{ createdAt: "2026-08-05T09:00:00Z" }] }),
  );
  assert.equal(rec.delivered_at, "2026-08-05");
});

test("the ticket's order id is kept, not Shopify's order name", () => {
  const rec = toOrderRecord("ORD-1101", order());
  assert.equal(rec.order_id, "ORD-1101");
});

test("the Dodo payment id is read from the order note", () => {
  assert.equal(toOrderRecord("ORD-1101", order()).payment_id, "pay_abc123");
  assert.equal(toOrderRecord("ORD-1101", order({ note: null })).payment_id, undefined);
});

test("amount and narration come from the order total", () => {
  const rec = toOrderRecord("ORD-1101", order());
  assert.equal(rec.amount_minor, 149900);
  assert.equal(rec.currency, "INR");
  assert.match(rec.amount_narrated, /1,499/);
});

test("a shipping item is physical and returnable; a non-shipping one is digital", () => {
  const physical = toOrderRecord("ORD-1101", order());
  assert.equal(physical.item_type, "physical");
  assert.equal(physical.returnable, true);

  const digital = toOrderRecord(
    "ORD-2102",
    order({ lineItems: { nodes: [{ title: "Premium Annual Plan", requiresShipping: false }] } }),
  );
  assert.equal(digital.item_type, "digital");
  assert.equal(digital.returnable, false);
});

test("an amount with cents is narrated with its cents, never rounded", () => {
  const rec = toOrderRecord(
    "ORD-1001",
    order({ currentTotalPriceSet: { shopMoney: { amount: "14.99", currencyCode: "USD" } } }),
  );
  assert.equal(rec.amount_minor, 1499);
  assert.match(rec.amount_narrated, /14\.99/);
});
