import { useEffect, useRef, useState } from "react";

const SCRIPT_SRC = "https://unpkg.com/@elevenlabs/convai-widget-embed";

/**
 * Floating voice-call bubble, draggable via the ⠿ grip beside it.
 *
 * The agent id comes from GET /app-config (which reads ELEVENLABS_AGENT_ID in
 * the server's .env), so switching ElevenLabs accounts is an .env edit + server
 * restart — no rebuild. The id is client-visible by design (the widget is meant
 * to be embedded); the agent must allow unauthenticated widget access in the
 * ElevenLabs dashboard.
 *
 * Drag design — third attempt; the first two are cautionary tales. The widget
 * positions itself `position: fixed` from inside its own shadow DOM, so the
 * only handle we have on it is a transformed ancestor (a transformed box
 * becomes the containing block for fixed descendants). Sized to the bubble
 * that ancestor hid the widget; sized to the viewport it swallowed every click
 * on the page behind it. This version fixes both at once: the wrapper is
 * viewport-sized but carries `pointer-events: none` (clicks fall through), and
 * dragging happens ONLY on our own grip button — no handlers ever touch the
 * widget element, so tap-to-open, panel scrolling and the mic flow keep their
 * native behavior.
 */

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  baseX: number;
  baseY: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export default function ElevenLabsWidget() {
  const [agentId, setAgentId] = useState("");
  const [pos, setPos] = useState({ x: 0, y: 0 });
  // Session-only: hiding is plain state, never persisted — a refresh brings
  // the bubble back. Hiding mid-call ends the call (the element unmounts).
  const [hidden, setHidden] = useState(false);
  const dragRef = useRef<DragState | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/app-config")
      .then((res) => res.json())
      .then(({ elevenLabsAgentId }) => {
        if (cancelled) return;
        if (elevenLabsAgentId) setAgentId(elevenLabsAgentId);
        else console.warn("ElevenLabs widget disabled: ELEVENLABS_AGENT_ID not set in the server .env");
      })
      .catch((err) => console.warn("ElevenLabs widget disabled: /app-config unreachable", err));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!agentId) return;
    if (document.querySelector(`script[src="${SCRIPT_SRC}"]`)) return;
    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    document.body.appendChild(script);
    // Intentionally no cleanup: the widget script registers a custom element,
    // which cannot be unregistered — removing the tag would not undo it.
  }, [agentId]);

  function onGripDown(e: React.PointerEvent<HTMLButtonElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, baseX: pos.x, baseY: pos.y };
  }

  function onGripMove(e: React.PointerEvent<HTMLButtonElement>) {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    // Home position is bottom-right, so movement is leftward/upward = negative.
    // Clamp so the grip can never be dragged fully off-screen.
    setPos({
      x: clamp(d.baseX + e.clientX - d.startX, -(window.innerWidth - 96), 0),
      y: clamp(d.baseY + e.clientY - d.startY, -(window.innerHeight - 160), 0),
    });
  }

  function onGripUp() {
    dragRef.current = null;
  }

  if (!agentId || hidden) return null;
  return (
    <div className="voice-dock" style={{ transform: `translate(${pos.x}px, ${pos.y}px)` }}>
      <div className="voice-controls">
        <button
          type="button"
          className="voice-btn voice-close"
          title="Hide the voice bubble (refresh brings it back)"
          aria-label="Hide voice call bubble"
          onClick={() => setHidden(true)}
        >
          ×
        </button>
        <button
          type="button"
          className="voice-btn voice-grip"
          title="Drag to move the voice bubble"
          aria-label="Move voice call bubble"
          onPointerDown={onGripDown}
          onPointerMove={onGripMove}
          onPointerUp={onGripUp}
          onPointerCancel={onGripUp}
        >
          ⠿
        </button>
      </div>
      <elevenlabs-convai agent-id={agentId} />
    </div>
  );
}
