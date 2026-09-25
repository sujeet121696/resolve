import { useCallback, useEffect, useState } from "react";

// Costs tab — the unit-economics view. Everything is computed server-side
// (/dashboard-metrics aggregates the audit trail + ElevenLabs call durations,
// priced by config/pricing.json); this page only renders numbers.

interface VoiceCall {
  started_at: string;
  duration_secs: number;
  source: string;
  language: string;
  status: string;
  successful: string;
  title: string | null;
  cost_credits: number | null;
}

interface Metrics {
  generated_at: string;
  pricing: {
    llm: { provider: string; model: string; usd_per_mtok_in: number; usd_per_mtok_out: number };
    voice: { provider: string; usd_per_min: number; usd_per_credit?: number };
    telephony: { provider: string; inr_per_min: number; usd_per_inr: number };
    payments: { provider: string; usd_fee_per_refund: number };
    helpdesk: { provider: string; usd_per_month: number; note?: string };
  };
  per_call: {
    avg_call_minutes: number | null;
    avg_tokens_in: number;
    avg_tokens_out: number;
    llm_usd: number;
    voice_usd: number | null;
    telephony_usd: number | null;
    subtotal_usd: number;
    with_refund_fee_usd: number;
    human_benchmark_usd: [number, number];
  };
  totals: {
    cases: number;
    llm: { calls: number; tokens_in: number; tokens_out: number; by_model: Record<string, number>; usd: number };
    voice: {
      calls: number;
      total_minutes: number;
      credits: number;
      usd_actual: number;
      usd_at_rate: number;
      recent_calls: VoiceCall[];
    } | null;
    telephony_estimate: { minutes: number; inr: number; usd: number } | null;
    payments: { refunds_succeeded: number; refunds_blocked: number; fees_usd: number };
    helpdesk: { notes_added: number; escalations: number };
    guard: { approved: number; denied: number; denial_reasons: Record<string, number> };
    outcomes: {
      refunds_completed: number;
      returns_requested: number;
      escalated_to_human: number;
      otp_sent: number;
      otp_lockouts: number;
    };
  };
}

const usd = (n: number, places = 2) => `$${n.toFixed(places)}`;

const fmtWhen = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });

const fmtDur = (secs: number) => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;

const PAGE_SIZES = [10, 20, 50];

// Friendly names for ElevenLabs' raw conversation sources; filtering still
// keys on the raw value, only the display changes.
const SOURCE_LABELS: Record<string, string> = { sip_trunk: "Phone", phone_call: "Phone", widget: "Chat" };
const srcLabel = (s: string) => SOURCE_LABELS[s] ?? s;

// Time-range presets for every aggregate on the page; "date" (the calendar
// picker) is the sixth, non-preset option. Default is the last 4 hours.
const RANGES = [
  { key: "10m", label: "10 min", query: "minutes=10", heading: "Last 10 minutes" },
  { key: "1h", label: "1 hour", query: "minutes=60", heading: "Last hour" },
  { key: "4h", label: "4 hours", query: "minutes=240", heading: "Last 4 hours" },
  { key: "today", label: "today", query: "period=today", heading: "Today so far" },
  { key: "all", label: "all time", query: "period=all", heading: "This deployment so far" },
] as const;
type RangeKey = (typeof RANGES)[number]["key"] | "date";

export default function Dashboard() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0]);
  const [sourceFilter, setSourceFilter] = useState("all");
  const [range, setRange] = useState<RangeKey>("4h");
  const [date, setDate] = useState(""); // YYYY-MM-DD when the calendar is used
  const [ccy, setCcy] = useState<"usd" | "inr">("usd");

  const load = useCallback(() => {
    const query =
      range === "date" && date ? `date=${date}` : (RANGES.find((r) => r.key === range) ?? RANGES[2]).query;
    setLoading(true);
    fetch(`/dashboard-metrics?${query}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data) => {
        setMetrics(data);
        setError("");
      })
      .catch((err) => setError(`Could not load metrics: ${err.message} — is the server running?`))
      .finally(() => setLoading(false));
  }, [range, date]);

  useEffect(load, [load]);

  if (error) return <div className="dash"><p className="dash-error">{error}</p></div>;
  if (!metrics) return <div className="dash"><p className="dash-dim">Loading cost metrics…</p></div>;

  const { per_call: pc, totals: t, pricing: p } = metrics;
  const [benchLow, benchHigh] = pc.human_benchmark_usd;
  const savings = Math.round((1 - pc.subtotal_usd / benchLow) * 100);
  const inr = (n: number) => `₹${Math.round(n / p.telephony.usd_per_inr)}`;
  // One display helper for every money figure: USD as stored, or converted to
  // INR via the rate card. INR drops ~2 decimal places (₹39, not ₹39.05).
  const money = (n: number, places = 2) =>
    ccy === "usd" ? usd(n, places) : `₹${(n / p.telephony.usd_per_inr).toFixed(Math.max(0, places - 2))}`;
  const alt = (n: number) => (ccy === "usd" ? inr(n) : usd(n));

  const calls = t.voice?.recent_calls ?? [];
  const sources = Array.from(new Set(calls.map((c) => c.source))).sort();
  const filtered = sourceFilter === "all" ? calls : calls.filter((c) => c.source === sourceFilter);
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const cur = Math.min(page, pageCount - 1);
  const pageCalls = filtered.slice(cur * pageSize, cur * pageSize + pageSize);
  const filteredCredits = filtered.reduce((sum, c) => sum + (c.cost_credits ?? 0), 0);
  const filteredUsd =
    sourceFilter === "all" && t.voice
      ? t.voice.usd_actual
      : filteredCredits * (p.voice.usd_per_credit ?? 0);

  return (
    <div className="dash">
      <div className="dash-head">
        <div>
          <h1>What every call costs</h1>
          <div className="dash-badges">
            <span className="badge live">● live</span>
            <span className="badge">audit trail</span>
            <span className="badge">real ElevenLabs billing</span>
            <span className="badge">aggregates only — no customer data</span>
          </div>
        </div>
        <div className="dash-head-right">
          <div className="period-toggle">
            {(["usd", "inr"] as const).map((c) => (
              <button key={c} className={`filter-pill ${ccy === c ? "active" : ""}`} onClick={() => setCcy(c)}>
                {c === "usd" ? "$ USD" : "₹ INR"}
              </button>
            ))}
          </div>
          <div className="period-toggle">
            {RANGES.map((r) => (
              <button
                key={r.key}
                className={`filter-pill ${range === r.key ? "active" : ""}`}
                onClick={() => {
                  setRange(r.key);
                  setPage(0);
                }}
              >
                {r.label}
              </button>
            ))}
            <input
              type="date"
              className={`filter-pill ${range === "date" ? "active" : ""}`}
              value={date}
              max={new Date().toISOString().slice(0, 10)}
              onChange={(e) => {
                setDate(e.target.value);
                if (e.target.value) {
                  setRange("date");
                  setPage(0);
                }
              }}
              title="Show one calendar day"
            />
          </div>
          <span className="dash-updated">updated {fmtWhen(metrics.generated_at)}</span>
          <button onClick={load} disabled={loading}>
            {loading ? "refreshing…" : "refresh"}
          </button>
        </div>
      </div>

      <div className="dash-hero">
        <div className="hero-stat main">
          <div className="hero-value">
            {money(pc.subtotal_usd)} <span className="hero-inr">≈ {alt(pc.subtotal_usd)}</span>
          </div>
          <div className="hero-label">per call, fully loaded</div>
          <div className="hero-sub">
            voice + telephony + brain · {pc.avg_call_minutes ?? "?"} min avg call ·{" "}
            {pc.avg_tokens_in + pc.avg_tokens_out} tokens/case · all-time averages
          </div>
        </div>
        <div className="hero-stat">
          <div className="hero-value">
            {money(pc.with_refund_fee_usd)} <span className="hero-inr">≈ {alt(pc.with_refund_fee_usd)}</span>
          </div>
          <div className="hero-label">when money moves</div>
          <div className="hero-sub">+ {money(p.payments.usd_fee_per_refund)} refund fee ({p.payments.provider})</div>
        </div>
        <div className="hero-stat">
          <div className="hero-value">
            {money(benchLow, 0)}–{money(benchHigh, 0)}
          </div>
          <div className="hero-label">human-handled ticket</div>
          <div className="hero-sub">industry benchmark — Resolve is ~{savings}% cheaper</div>
        </div>
      </div>

      <h3>Where one call's cost goes</h3>
      <table className="dash-table">
        <thead>
          <tr>
            <th>Layer</th>
            <th>Provider</th>
            <th>Basis</th>
            <th className="num">Per call</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Voice agent</td>
            <td>{p.voice.provider}</td>
            <td>
              {pc.avg_call_minutes ?? "?"} min × {money(p.voice.usd_per_min)}/min
            </td>
            <td className="num">{pc.voice_usd !== null ? money(pc.voice_usd, 3) : "—"}</td>
          </tr>
          <tr>
            <td>Telephony</td>
            <td>{p.telephony.provider}</td>
            <td>
              {pc.avg_call_minutes ?? "?"} min × ₹{p.telephony.inr_per_min}/min
            </td>
            <td className="num">{pc.telephony_usd !== null ? money(pc.telephony_usd, 3) : "—"}</td>
          </tr>
          <tr>
            <td>Brain (propose + judge)</td>
            <td>
              {p.llm.provider} · {p.llm.model}
            </td>
            <td>
              {pc.avg_tokens_in} in / {pc.avg_tokens_out} out tokens
            </td>
            <td className="num">{money(pc.llm_usd, 4)}</td>
          </tr>
          <tr>
            <td>Helpdesk</td>
            <td>{p.helpdesk.provider}</td>
            <td>{p.helpdesk.note ?? "subscription"}</td>
            <td className="num">{p.helpdesk.usd_per_month === 0 ? "included" : money(p.helpdesk.usd_per_month)}</td>
          </tr>
          <tr className="total">
            <td colSpan={3}>Cost per call (+{money(p.payments.usd_fee_per_refund)} only if a refund fires)</td>
            <td className="num">{money(pc.subtotal_usd)}</td>
          </tr>
        </tbody>
      </table>

      <h3>{range === "date" && date ? `On ${date}` : (RANGES.find((r) => r.key === range) ?? RANGES[2]).heading}</h3>
      <div className="dash-grid">
        <div className="dash-card">
          <h4>🎙️ Voice — {p.voice.provider}</h4>
          {t.voice ? (
            <ul>
              <li>
                <b>{t.voice.calls}</b> conversations · <b>{t.voice.total_minutes}</b> min
              </li>
              <li>
                real charges <b>{t.voice.credits.toLocaleString()}</b> credits ≈ <b>{money(t.voice.usd_actual)}</b> ·
                telephony est. ₹{t.telephony_estimate?.inr} ({money(t.telephony_estimate?.usd ?? 0)})
              </li>
            </ul>
          ) : (
            <p className="dash-dim">ElevenLabs API unreachable — totals hidden, rates above still apply.</p>
          )}
        </div>
        <div className="dash-card">
          <h4>🧠 Brain — {p.llm.provider}</h4>
          <ul>
            <li>
              <b>{t.llm.calls}</b> LLM calls across <b>{t.cases}</b> cases
            </li>
            <li>
              {t.llm.tokens_in.toLocaleString()} in / {t.llm.tokens_out.toLocaleString()} out → <b>{money(t.llm.usd)}</b> total
            </li>
          </ul>
        </div>
        <div className="dash-card">
          <h4>💸 Payments — {p.payments.provider}</h4>
          <ul>
            <li>
              <b>{t.payments.refunds_succeeded}</b> refunds completed · fees {money(t.payments.fees_usd)}
            </li>
            <li>
              <b>{t.payments.refunds_blocked}</b> blocked at the provider (duplicates caught, held for a human)
            </li>
          </ul>
        </div>
        <div className="dash-card">
          <h4>🎫 Helpdesk — {p.helpdesk.provider}</h4>
          <ul>
            <li>
              <b>{t.helpdesk.notes_added}</b> resolution notes · <b>{t.helpdesk.escalations}</b> escalation briefings
            </li>
            <li>
              OTP: {t.outcomes.otp_sent} sent · {t.outcomes.otp_lockouts} lockouts enforced
            </li>
          </ul>
        </div>
      </div>

      <h3>Every voice call — real charges from ElevenLabs</h3>
      {t.voice && calls.length > 0 ? (
        <>
          <div className="calls-toolbar">
            <span className="dash-dim">Source:</span>
            {["all", ...sources].map((s) => (
              <button
                key={s}
                className={`filter-pill ${sourceFilter === s ? "active" : ""}`}
                onClick={() => {
                  setSourceFilter(s);
                  setPage(0);
                }}
              >
                {s === "all" ? "all" : srcLabel(s)}
              </button>
            ))}
          </div>
          <table className="dash-table calls">
            <thead>
              <tr>
                <th>When</th>
                <th>Source</th>
                <th>Lang</th>
                <th>Result</th>
                <th className="num">Duration</th>
                <th className="num">Credits</th>
                <th className="num">{ccy === "usd" ? "USD" : "INR"}</th>
              </tr>
            </thead>
            <tbody>
              {pageCalls.map((c, i) => (
                <tr key={`${c.started_at}-${i}`}>
                  <td>{fmtWhen(c.started_at)}</td>
                  <td>{srcLabel(c.source)}</td>
                  <td>{c.language}</td>
                  <td>
                    <span className={`call-result ${c.successful}`}>{c.successful}</span>
                  </td>
                  <td className="num">{fmtDur(c.duration_secs)}</td>
                  <td className="num">{c.cost_credits ?? "—"}</td>
                  <td className="num">
                    {c.cost_credits !== null && p.voice.usd_per_credit
                      ? money(c.cost_credits * p.voice.usd_per_credit, 3)
                      : "—"}
                  </td>
                </tr>
              ))}
              {pageCalls.length === 0 && (
                <tr>
                  <td colSpan={7} className="dash-dim">
                    No calls from this source.
                  </td>
                </tr>
              )}
              <tr className="total">
                <td colSpan={5}>
                  {sourceFilter === "all"
                    ? `${calls.length} calls (of ${t.voice.calls}) · charges as billed by ElevenLabs`
                    : `${filtered.length} calls via ${srcLabel(sourceFilter)} · charges as billed by ElevenLabs`}
                </td>
                <td className="num">{filteredCredits.toLocaleString()}</td>
                <td className="num">{money(filteredUsd)}</td>
              </tr>
            </tbody>
          </table>
          <div className="pager">
            <select
              value={pageSize}
              onChange={(e) => {
                setPageSize(Number(e.target.value));
                setPage(0);
              }}
            >
              {PAGE_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n} / page
                </option>
              ))}
            </select>
            <div className="pager-nav">
              <span className="pager-range">
                {filtered.length === 0 ? "0" : `${cur * pageSize + 1}–${Math.min((cur + 1) * pageSize, filtered.length)}`} of{" "}
                {filtered.length}
              </span>
              <button disabled={cur === 0} onClick={() => setPage(cur - 1)}>
                ‹ Prev
              </button>
              <span className="pager-count">
                Page {cur + 1} of {pageCount}
              </span>
              <button disabled={cur >= pageCount - 1} onClick={() => setPage(cur + 1)}>
                Next ›
              </button>
            </div>
          </div>
        </>
      ) : t.voice ? (
        <p className="dash-dim">No calls in this time range — try a wider one, or “all time” for the full history.</p>
      ) : (
        <p className="dash-dim">ElevenLabs API unreachable — call table unavailable right now.</p>
      )}

      <h3>The guard's record — why this is safe autonomy</h3>
      <div className="dash-guard">
        <p>
          <b>{t.guard.approved}</b> approved · <b>{t.guard.denied}</b> denied before any money moved — every denial
          deterministic, by hard check:
        </p>
        <div className="guard-pills">
          {Object.entries(t.guard.denial_reasons)
            .sort((a, b) => b[1] - a[1])
            .map(([check, n]) => (
              <span key={check} className="pill">
                <b>{check}</b> × {n}
              </span>
            ))}
        </div>
        <p className="dash-dim">
          Outcomes: {t.outcomes.refunds_completed} refunds · {t.outcomes.returns_requested} returns arranged ·{" "}
          {t.outcomes.escalated_to_human} escalated to a human with a briefing and follow-up.
        </p>
      </div>

      <p className="dash-foot">
        Computed live from the audit trail and the ElevenLabs API · rates from <code>config/pricing.json</code> (editable
        rate card) · this endpoint returns aggregates only — no customer data leaves the server.
      </p>
    </div>
  );
}
