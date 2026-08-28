// Returns / RMA — the "not yet" branch of a refund (physical goods only).
//
// Refunding a physical item is not a judgment call, it's a sequence: the
// product comes back, THEN the money goes out. So the Policy-Guard's
// awaiting_return hard check doesn't dead-end the case the way a limit breach
// does — it routes here, and this module arranges the return on the ticket.
//
// Three deliberate choices:
//   - Keyed by ORDER id, not ticket or conversation. The return belongs to the
//     product, so a repeat call, a re-run on the same ticket, or a second
//     ticket about the same order all find the existing RMA instead of
//     arranging a second pickup for one parcel.
//   - No new ticket. helpdesk.ts keeps createTicket out of the seam, and real
//     RMA flows don't fork the case: the refund ticket stays open in
//     awaiting-return status with the RMA recorded on it. One audit trail, and
//     per-ticket idempotency keeps working.
//   - "Received" is only ever set by markReturnReceived, called by the
//     warehouse hook. Nothing the customer says in the conversation can mark
//     their own parcel as returned — same shape as the OTP verified flag.
//
// File-backed (data/returns.json) for the same reason as the action store: a
// dev-server restart must not forget an RMA and arrange the pickup twice.

import fs from "node:fs";
import path from "node:path";
import type { CaseFacts } from "./types.js";
import { getHelpdesk } from "./helpdesk.js";
import { emitEvent } from "./events.js";

export interface ReturnRecord {
  rma: string;
  order_id: string;
  ticket_id: string;
  state: "requested" | "received";
  requested_at: string;
  received_at?: string;
}

const DATA_DIR = path.resolve(process.cwd(), "data");
const STORE_FILE = path.join(DATA_DIR, "returns.json");

function load(): Record<string, ReturnRecord> {
  try {
    return JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function save(records: Record<string, ReturnRecord>): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STORE_FILE, JSON.stringify(records, null, 2));
}

export function getReturn(orderId: string): ReturnRecord | undefined {
  return load()[orderId];
}

/**
 * The warehouse scanned the parcel in. In production this is a WMS webhook; in
 * the demo it's a token-guarded POST. Flipping this is what unblocks the refund
 * on the next attempt — the guard re-reads it as return_status "completed".
 */
export function markReturnReceived(orderId: string): ReturnRecord | undefined {
  const records = load();
  const record = records[orderId];
  if (!record) return undefined;
  if (record.state === "received") {
    emitEvent("return.already_received", `Return ${record.rma} was already marked received — ignoring repeat scan`);
    return record;
  }
  record.state = "received";
  record.received_at = new Date().toISOString();
  save(records);
  emitEvent("return.received", `Return ${record.rma} received for ${orderId} — refund is now unblocked`, {
    rma: record.rma,
    ticket_id: record.ticket_id,
  });
  return record;
}

/**
 * Seed-only: record a parcel that was already back before the customer ever
 * contacted us (`seed:repeat --returned`). This does NOT weaken the rule above —
 * that rule is about the customer-facing path, and a seed script stands in for
 * the warehouse, not for the customer. Nothing reachable from a conversation
 * calls this.
 */
export function seedReceivedReturn(orderId: string, ticketId: string): ReturnRecord {
  const now = new Date().toISOString();
  const record: ReturnRecord = {
    rma: `RMA-${orderId.replace(/\D/g, "") || ticketId}`,
    order_id: orderId,
    ticket_id: ticketId,
    state: "received",
    requested_at: now,
    received_at: now,
  };
  const records = load();
  records[orderId] = record;
  save(records);
  return record;
}

/**
 * CaseFacts are a snapshot taken when the context was looked up, but the parcel
 * can arrive between that lookup and the decision. The guard has to judge on
 * where the item actually is, so the RMA store is re-read at decision time —
 * the same principle as the OTP verified flag: authority lives server-side,
 * never in a cached summary the conversation could be holding.
 */
export function withLiveReturnStatus(facts: CaseFacts): CaseFacts {
  if (facts.item_type !== "physical") return facts;
  const record = getReturn(facts.order_id);
  if (!record) return facts;
  const live: CaseFacts["return_status"] = record.state === "received" ? "completed" : "requested";
  if (live === facts.return_status) return facts;
  emitEvent(
    "return.status_refreshed",
    `Return status for ${facts.order_id}: ${facts.return_status} → ${live} (${record.rma})`,
  );
  return { ...facts, return_status: live };
}

export interface ReturnRequestResult {
  rma: string;
  duplicate: boolean;
  /** What the agent says out loud / types back to the customer. */
  message: string;
  /** One line for the ops view and the resolve_case result. */
  note: string;
}

/** RMA-1010 from ORD-1010; falls back to the ticket id if the order has no digits. */
function rmaFor(facts: CaseFacts): string {
  const digits = facts.order_id.replace(/\D/g, "");
  return `RMA-${digits || facts.ticket_id}`;
}

function customerMessage(record: ReturnRecord, amountNarrated: string, duplicate: boolean): string {
  if (record.state === "received") {
    return `We've already received the item for order ${record.order_id} under ${record.rma}, so the refund can go ahead — please confirm once more and I'll process it.`;
  }
  const opening = duplicate
    ? `We've already arranged the return for order ${record.order_id} under ${record.rma}, so I haven't raised a second pickup.`
    : `Before I can refund this, the item needs to come back to us. I've arranged a return pickup for order ${record.order_id} and logged it on your ticket as ${record.rma}.`;
  return `${opening} Once the warehouse scans it in, the refund of ${amountNarrated} is released automatically and you'll get a confirmation email. Nothing else for you to do.`;
}

/**
 * Arrange the return, or report the one that already exists. Best-effort on the
 * helpdesk side by contract: the RMA record is written FIRST, so a Freshdesk
 * failure can never lose it and let a second pickup be raised later.
 */
export async function requestReturn(facts: CaseFacts, amountNarrated?: string): Promise<ReturnRequestResult> {
  const narrated = amountNarrated ?? `${(facts.amount / 100).toFixed(2)} ${facts.currency}`;

  const existing = getReturn(facts.order_id);
  if (existing) {
    emitEvent("return.duplicate", `Return already open for ${facts.order_id} (${existing.rma}) — no second pickup raised`, {
      rma: existing.rma,
      state: existing.state,
      requested_at: existing.requested_at,
    });
    return {
      rma: existing.rma,
      duplicate: true,
      message: customerMessage(existing, narrated, true),
      note: `Return ${existing.rma} already ${existing.state} since ${existing.requested_at} — no duplicate raised.`,
    };
  }

  const record: ReturnRecord = {
    rma: rmaFor(facts),
    order_id: facts.order_id,
    ticket_id: facts.ticket_id,
    state: "requested",
    requested_at: new Date().toISOString(),
  };
  const records = load();
  records[record.order_id] = record;
  save(records);

  // Ticket side: the case stays open, parked in "awaiting return" with the RMA
  // on it. Failures here are logged — the RMA above is already durable.
  const helpdesk = getHelpdesk();
  const ticketNumber = Number(facts.ticket_id);
  if (helpdesk.configured() && Number.isFinite(ticketNumber)) {
    try {
      await helpdesk.updateTicket(ticketNumber, { status: 3 }); // 3 = pending (awaiting the customer/parcel)
      await helpdesk.addNote(
        ticketNumber,
        `<p><b>Resolve — return arranged (automated)</b></p>
         <p><b>Why the refund did not fire:</b> the Policy-Guard's awaiting_return hard check —
         ${facts.order_id} is a physical item and it has not been returned yet.</p>
         <p><b>RMA:</b> ${record.rma}<br>
         <b>Order:</b> ${facts.order_id} — ${(facts.amount / 100).toFixed(2)} ${facts.currency}<br>
         <b>Ticket parked:</b> pending, awaiting the parcel<br>
         <b>Identity:</b> verified by OTP during the conversation</p>
         <p><b>What happens next:</b> when the return is scanned in, the refund is released
         on the customer's next contact — no second RMA will be raised for this order.</p>`,
      );
      emitEvent("freshdesk.note_added", `Return note added to ticket #${ticketNumber}`);
    } catch (err) {
      emitEvent("case.warn", `Freshdesk update failed (RMA ${record.rma} still recorded): ${(err as Error).message}`);
    }
  } else {
    emitEvent("freshdesk.skipped", "Freshdesk not configured or non-numeric ticket id — return note skipped");
  }

  emitEvent("return.requested", `Return ${record.rma} arranged for ${facts.order_id} — refund held until it arrives`, {
    rma: record.rma,
    ticket_id: facts.ticket_id,
    amount: facts.amount,
  });

  return {
    rma: record.rma,
    duplicate: false,
    message: customerMessage(record, narrated, false),
    note: `Return ${record.rma} arranged; ticket parked pending the parcel. No money moved.`,
  };
}
