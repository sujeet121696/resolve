// The helpdesk seam — same idea as brain.ts, for the system of record.
//
// Case context comes from here and resolutions are written back here, so the
// helpdesk is swappable via the HELPDESK env var:
//   HELPDESK=freshdesk → Freshdesk v2 REST API (the default and the demo path)
//
// Adding a provider (Zendesk, Intercom, an internal CRM) means writing one
// module that satisfies Helpdesk and adding a line to getHelpdesk().
//
// Two deliberate boundaries:
//   - createTicket is NOT part of this interface. Only the seed scripts create
//     tickets, and they're allowed to be vendor-specific (see payments.ts).
//   - The helpdesk owns the COMPLAINT, not the order facts. case-context.ts
//     takes exactly one fact-bearing token from a ticket — the order id — and
//     reads everything the guard judges from the order source (oms.ts). So a
//     new helpdesk needs no body format and no parser: if its tickets carry an
//     order number, it works.

import { freshdeskHelpdesk } from "./integrations/freshdesk.js";

/** Provider-neutral ticket. Priority 1 low → 4 urgent; status 2 open → 3 pending. */
export interface Ticket {
  id: number;
  subject: string;
  description_text?: string;
  status: number;
  priority: number;
  tags: string[];
}

export interface Helpdesk {
  /** Which implementation is live — shown on the ops view. */
  name: "freshdesk";
  /** False when credentials are missing — callers degrade instead of throwing. */
  configured(): boolean;
  getTicket(ticketId: number): Promise<Ticket>;
  /** Tickets raised by a requester email (empty array if the contact is unknown). */
  listTicketsByEmail(email: string): Promise<Ticket[]>;
  addNote(ticketId: number, bodyHtml: string, isPrivate?: boolean): Promise<{ id: number }>;
  updateTicket(
    ticketId: number,
    fields: { priority?: 1 | 2 | 3 | 4; status?: number },
  ): Promise<Ticket>;
}

export function getHelpdesk(): Helpdesk {
  const choice = (process.env.HELPDESK ?? "freshdesk").toLowerCase();
  if (choice !== "freshdesk") {
    console.warn(`Unknown HELPDESK="${choice}" — falling back to freshdesk`);
  }
  return freshdeskHelpdesk;
}
