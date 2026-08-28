// Idempotency store — one action per ticket (DESIGN.md decision 3).
//
// File-backed (data/actions.json) so dev-server restarts can't forget an
// in-flight refund and double-pay. The record is written BEFORE the money
// call fires; states:
//   in_flight → crashed mid-action: refuse to retry automatically, flag for manual check
//   done      → repeat calls return the recorded result, no second action

import fs from "node:fs";
import path from "node:path";

export interface ActionRecord {
  ticket_id: string;
  state: "in_flight" | "done";
  action: string;
  started_at: string;
  finished_at?: string;
  result?: unknown;
}

const DATA_DIR = path.resolve(process.cwd(), "data");
const STORE_FILE = path.join(DATA_DIR, "actions.json");

function load(): Record<string, ActionRecord> {
  try {
    return JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function save(records: Record<string, ActionRecord>): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STORE_FILE, JSON.stringify(records, null, 2));
}

export function getAction(ticketId: string): ActionRecord | undefined {
  return load()[ticketId];
}

/** Write the in-flight record BEFORE firing the money call. */
export function beginAction(ticketId: string, action: string): ActionRecord {
  const records = load();
  const record: ActionRecord = {
    ticket_id: ticketId,
    state: "in_flight",
    action,
    started_at: new Date().toISOString(),
  };
  records[ticketId] = record;
  save(records);
  return record;
}

export function completeAction(ticketId: string, result: unknown): ActionRecord {
  const records = load();
  const record = records[ticketId];
  if (!record) throw new Error(`completeAction: no in-flight record for ${ticketId}`);
  record.state = "done";
  record.finished_at = new Date().toISOString();
  record.result = result;
  save(records);
  return record;
}
