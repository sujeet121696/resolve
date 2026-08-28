import { useEffect, useState } from "react";

export interface ResolveEvent {
  seq: number;
  ts: string;
  type: string;
  message: string;
  data?: unknown;
}

const MAX_EVENTS = 500;

/**
 * Subscribes to the orchestrator's SSE stream (/events). The server replays
 * recent history on connect, so we dedupe by seq — that also makes StrictMode's
 * dev double-mount harmless (the second connection replays the same events).
 */
export function useEvents(): { events: ResolveEvent[]; live: boolean } {
  const [events, setEvents] = useState<ResolveEvent[]>([]);
  const [live, setLive] = useState(false);

  useEffect(() => {
    const source = new EventSource("/events");
    source.onopen = () => setLive(true);
    source.onerror = () => setLive(false);
    source.onmessage = (m) => {
      const event = JSON.parse(m.data) as ResolveEvent;
      setEvents((prev) => {
        if (prev.some((p) => p.seq === event.seq)) return prev;
        const next = [...prev, event];
        return next.length > MAX_EVENTS ? next.slice(-MAX_EVENTS) : next;
      });
    };
    return () => source.close();
  }, []);

  return { events, live };
}
