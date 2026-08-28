// Event bus — every subsystem reports here; the ops view renders it live.
// emitEvent() is the only entry point: log + buffer + persist to the audit
// trail + push to SSE subscribers.

import { appendAudit } from "./audit.js";

export interface ResolveEvent {
  seq: number;
  ts: string; // ISO timestamp
  type: string; // dot-namespaced: "otp.sent", "guard.denied", "dodo.refund.created", ...
  message: string; // one human-readable line for the ops view
  data?: Record<string, unknown>; // structured details (amounts, ids) — no secrets
}

type Subscriber = (event: ResolveEvent) => void;

const HISTORY_LIMIT = 200;

const history: ResolveEvent[] = [];
const subscribers = new Set<Subscriber>();
let seq = 0;

export function emitEvent(
  type: string,
  message: string,
  data?: Record<string, unknown>,
): ResolveEvent {
  const event: ResolveEvent = {
    seq: ++seq,
    ts: new Date().toISOString(),
    type,
    message,
    ...(data ? { data } : {}),
  };
  history.push(event);
  if (history.length > HISTORY_LIMIT) history.shift();
  appendAudit(event);
  console.log(`[${event.ts}] ${event.type} — ${event.message}`);
  for (const notify of subscribers) notify(event);
  return event;
}

/** Subscribe to live events. Returns an unsubscribe function. */
export function subscribe(notify: Subscriber): () => void {
  subscribers.add(notify);
  return () => subscribers.delete(notify);
}

/** Recent events, oldest first — replayed to browsers that connect late. */
export function recentEvents(): ResolveEvent[] {
  return [...history];
}
