import { useEffect, useRef, useState, type FormEvent } from "react";
import { sendChat } from "../lib/api";

interface Message {
  role: "agent" | "user";
  text: string;
}

// The conversation state machine lives server-side keyed by this id; the
// component only renders the transcript.
function newSessionId(): string {
  return "s-" + Math.random().toString(36).slice(2, 10);
}

export default function Chat() {
  const sessionRef = useRef(newSessionId());
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null);
  const greetedRef = useRef(false);

  async function post(message: string) {
    setBusy(true);
    try {
      const reply = await sendChat(sessionRef.current, message);
      setMessages((prev) => [...prev, { role: "agent", text: reply }]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: "agent", text: `Connection problem — is the server running? ${(err as Error).message}` },
      ]);
    } finally {
      setBusy(false);
    }
  }

  // Fetch the greeting once (guarded ref keeps StrictMode's double-mount from
  // sending it twice).
  useEffect(() => {
    if (greetedRef.current) return;
    greetedRef.current = true;
    void post("");
  }, []);

  useEffect(() => {
    threadRef.current?.scrollTo(0, threadRef.current.scrollHeight);
  }, [messages, busy]);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setMessages((prev) => [...prev, { role: "user", text }]);
    setInput("");
    void post(text);
  }

  return (
    <div className="chat">
      <div className="thread" ref={threadRef}>
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            {m.text}
          </div>
        ))}
        {busy && <div className="msg agent typing">…</div>}
      </div>
      <form className="composer" onSubmit={onSubmit}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type a message…"
          autoComplete="off"
          autoFocus
        />
        <button type="submit" disabled={busy}>
          Send
        </button>
      </form>
    </div>
  );
}
