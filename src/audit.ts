// Audit log (Step 9) — the persistent decision trail.
//
// The ops view is an in-memory SSE stream: great on stage, gone on restart.
// This file survives, which is what makes "an AI moved money" defensible after
// the fact — every proposal, guard verdict, refund, and denial, in order.
//
// Append-only JSONL at data/audit.jsonl (data/ is gitignored — the trail holds
// real customer emails and payment ids). Writes are fire-and-forget: an audit
// failure must never break a live call, so errors are logged and swallowed.

import fs from "node:fs";
import path from "node:path";
import type { ResolveEvent } from "./events.js";

const DATA_DIR = path.resolve(process.cwd(), "data");
export const AUDIT_FILE = path.join(DATA_DIR, "audit.jsonl");

let dirReady = false;
let warned = false;

export function appendAudit(event: ResolveEvent): void {
  try {
    if (!dirReady) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      dirReady = true;
    }
    fs.appendFile(AUDIT_FILE, JSON.stringify(event) + "\n", (err) => {
      if (err && !warned) {
        warned = true;
        console.error(`[audit] append failed (continuing): ${err.message}`);
      }
    });
  } catch (err) {
    if (warned) return;
    warned = true;
    console.error(`[audit] disabled (continuing): ${(err as Error).message}`);
  }
}

/** Read the trail back, oldest first. Skips any partially-written line. */
export function readAudit(): ResolveEvent[] {
  let raw: string;
  try {
    raw = fs.readFileSync(AUDIT_FILE, "utf8");
  } catch {
    return [];
  }
  const events: ResolveEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as ResolveEvent);
    } catch {
      // Truncated tail from a kill mid-append — ignore, keep the rest.
    }
  }
  return events;
}
