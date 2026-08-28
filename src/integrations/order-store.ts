// Local order source (OMS=local) — data/orders.json, keyed by order id.
//
// Stands in for the order-management system a real deployment would read. It is
// shaped like an OMS export rather than like our convenience: every field is one
// a Shopify/Medusa order genuinely carries, so swapping in a live platform is a
// mapping job, not a redesign (oms.ts).
//
// File-backed for the same reason as the action and return stores: a dev-server
// restart must not forget which payment an order was bound to.

import fs from "node:fs";
import path from "node:path";
import type { OrderRecord, OrderSource } from "../oms.js";

const DATA_DIR = path.resolve(process.cwd(), "data");
const STORE_FILE = path.join(DATA_DIR, "orders.json");

function load(): Record<string, OrderRecord> {
  try {
    return JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
  } catch {
    return {}; // absent or corrupt → no orders, callers degrade to incomplete facts
  }
}

/**
 * Seed-only write path. Kept off the OrderSource interface on purpose: reading
 * order truth is a product capability, minting demo orders is not (oms.ts).
 */
export function putOrder(record: OrderRecord): OrderRecord {
  const records = load();
  records[record.order_id] = record;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STORE_FILE, JSON.stringify(records, null, 2));
  return record;
}

export const localOrderSource: OrderSource = {
  name: "local",
  configured: () => Object.keys(load()).length > 0,
  getOrder: async (orderId) => load()[orderId],
};
