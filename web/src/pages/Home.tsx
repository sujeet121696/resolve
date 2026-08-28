import { Link } from "react-router-dom";

export default function Home() {
  return (
    <>
      <main className="home">
        <h1>Resolve 🎙️💸</h1>
        <p className="tag">
          A voice-first support agent that hears the problem, verifies who's asking, and moves real money — with a
          policy guard and a human escalation path.
        </p>
        <p className="sub">
          <span className="live">●</span> Same brain behind every channel: propose → judge → act.
        </p>

        <div className="cards">
          <div className="card voice">
            <div className="icon">🎙️</div>
            <h2>Talk to Resolve</h2>
            <p>
              Click the call bubble in the corner of this page and speak — the agent looks up your ticket, verifies you
              by email OTP, and resolves it live.
            </p>
            <span className="cta">Use the call bubble ↘</span>
          </div>
          <Link className="card chat" to="/chat">
            <div className="icon">💬</div>
            <h2>Chat with Resolve</h2>
            <p>
              Same flow over text: email → confirm case → OTP → resolution. The live-demo fallback if the room's audio
              fights back.
            </p>
            <span className="cta">Open chat →</span>
          </Link>
          <Link className="card ops" to="/ops">
            <div className="icon">📊</div>
            <h2>Ops dashboard</h2>
            <p>
              Watch every decision as it happens: brain verdicts, guard denials, refunds, escalations, follow-ups — the
              audit trail, live.
            </p>
            <span className="cta">Open ops →</span>
          </Link>
        </div>

        <div className="how">
          <h3>How a case flows</h3>
          <div className="steps">
            <span className="pill">
              <b>Freshdesk</b> ticket
            </span>
            <span className="arrow">→</span>
            <span className="pill">
              <b>OTP</b> identity check
            </span>
            <span className="arrow">→</span>
            <span className="pill">
              <b>Brain</b> proposes
            </span>
            <span className="arrow">→</span>
            <span className="pill">
              <b>Guard</b> judges
            </span>
            <span className="arrow">→</span>
            <span className="pill">
              <b>Dodo</b> refund <i style={{ color: "var(--dim)" }}>or</i> <b>human</b> escalation
            </span>
          </div>
        </div>
      </main>
      <footer className="footer">Resolve — The Great Agent Hackathon @ TGPF 2026</footer>
    </>
  );
}
