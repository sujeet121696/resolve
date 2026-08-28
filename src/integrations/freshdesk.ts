// Freshdesk wrapper — plain fetch against the v2 REST API (validated by Spike 3).
// Auth is HTTP Basic with "apikey:X". Demo account is Freshdesk Omni; the
// classic ticket API works unchanged. Tickets carry the COMPLAINT only — the
// order facts come from the order source, and case-context.ts takes just the
// order id out of a ticket (see the boundary note in helpdesk.ts).

// Type-only import: the shared contract lives in the helpdesk seam, so there
// is no runtime cycle between seam and implementation.
import type { Helpdesk, Ticket } from "../helpdesk.js";

const DOMAIN = () => process.env.FRESHDESK_DOMAIN;
const API_KEY = () => process.env.FRESHDESK_API_KEY;

export function freshdeskConfigured(): boolean {
  return Boolean(DOMAIN() && API_KEY());
}

async function fd<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!freshdeskConfigured()) throw new Error("Freshdesk not configured (FRESHDESK_DOMAIN / FRESHDESK_API_KEY)");
  const res = await fetch(`https://${DOMAIN()}.freshdesk.com/api/v2${path}`, {
    ...init,
    headers: {
      Authorization: `Basic ${Buffer.from(`${API_KEY()}:X`).toString("base64")}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Freshdesk ${init.method ?? "GET"} ${path} → ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

/** Create a ticket; `email` auto-creates the contact if new. */
export async function createTicket(opts: {
  subject: string;
  descriptionHtml: string;
  email: string;
  name: string;
  priority?: 1 | 2 | 3 | 4; // low → urgent
  tags?: string[];
}): Promise<Ticket> {
  return fd<Ticket>("/tickets", {
    method: "POST",
    body: JSON.stringify({
      subject: opts.subject,
      description: opts.descriptionHtml,
      email: opts.email,
      name: opts.name,
      priority: opts.priority ?? 2,
      status: 2, // open
      tags: opts.tags ?? [],
    }),
  });
}

export async function getTicket(ticketId: number): Promise<Ticket> {
  return fd<Ticket>(`/tickets/${ticketId}`);
}

/** Update ticket fields (priority 1 low → 4 urgent; status 2 open → 3 pending). */
export async function updateTicket(
  ticketId: number,
  fields: { priority?: 1 | 2 | 3 | 4; status?: number },
): Promise<Ticket> {
  return fd<Ticket>(`/tickets/${ticketId}`, {
    method: "PUT",
    body: JSON.stringify(fields),
  });
}

export async function addNote(
  ticketId: number,
  bodyHtml: string,
  isPrivate = true,
): Promise<{ id: number }> {
  return fd<{ id: number }>(`/tickets/${ticketId}/notes`, {
    method: "POST",
    body: JSON.stringify({ body: bodyHtml, private: isPrivate }),
  });
}

/** Tickets raised by a requester email (empty array if the contact is unknown). */
export async function listTicketsByEmail(email: string): Promise<Ticket[]> {
  try {
    return await fd<Ticket[]>(`/tickets?email=${encodeURIComponent(email)}`);
  } catch {
    return [];
  }
}

/** This module as a Helpdesk — what getHelpdesk() hands the agents. */
export const freshdeskHelpdesk: Helpdesk = {
  name: "freshdesk",
  configured: freshdeskConfigured,
  getTicket,
  listTicketsByEmail,
  addNote,
  updateTicket,
};
