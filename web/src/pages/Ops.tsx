import { useEffect, useRef } from "react";
import { useEvents, type ResolveEvent } from "../lib/useEvents";

function badgeClass(type: string): string {
  if (/dodo|refund|payment/.test(type)) return "money";
  if (/denied|error|failed|refus/.test(type)) return "bad";
  if (/otp|verify/.test(type)) return "otp";
  if (/agent|guard|decide|escalat/.test(type)) return "agent";
  if (/warn|retry/.test(type)) return "warn";
  return "";
}

function Row({ event }: { event: ResolveEvent }) {
  const time = new Date(event.ts).toLocaleTimeString("en-IN", { hour12: false });
  return (
    <div className="event">
      <span className="ts">{time}</span>
      <span className={`type ${badgeClass(event.type)}`}>{event.type}</span>
      <span className="msg">
        {event.message}
        {event.data != null && (
          <details>
            <summary>data</summary>
            <pre>{JSON.stringify(event.data, null, 2)}</pre>
          </details>
        )}
      </span>
    </div>
  );
}

export default function Ops() {
  const { events, live } = useEvents();
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView();
  }, [events.length]);

  return (
    <>
      <div className={`ops-status ${live ? "live" : "dead"}`}>{live ? "live" : "disconnected — retrying"}</div>
      <div className="ops">
        {events.map((e) => (
          <Row key={e.seq} event={e} />
        ))}
        <div ref={bottomRef} />
      </div>
    </>
  );
}
