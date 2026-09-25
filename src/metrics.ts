// Cost dashboard metrics — the unit-economics story, computed from what the
// system already records rather than polled live from five vendors on stage.
//
// Sources, deliberately minimal:
//   1. data/audit.jsonl — cases, guard rulings, refunds, escalations, and the
//      brain.usage token counts every LLM call already emits.
//   2. ONE ElevenLabs API call (conversation list → call durations), cached
//      60s so a dashboard left open during a demo never hammers the API.
//   3. config/pricing.json — the editable rate card. Rates don't change
//      mid-demo; live billing APIs fail mid-demo.
//
// Everything returned is an aggregate: counts, minutes, tokens, dollars.
// Never customer emails or payment ids — the endpoint sits on the public
// tunnel, and the audit trail's PII stays in the file (see audit-report.ts).

import fs from "node:fs";
import path from "node:path";
import { readAudit } from "./audit.js";

const PRICING_FILE = path.resolve(process.cwd(), "config", "pricing.json");

interface Pricing {
  llm: { provider: string; model: string; usd_per_mtok_in: number; usd_per_mtok_out: number };
  voice: { provider: string; usd_per_min: number; usd_per_credit?: number };
  telephony: { provider: string; inr_per_min: number; usd_per_inr: number };
  payments: { provider: string; usd_fee_per_refund: number };
  helpdesk: { provider: string; usd_per_month: number; note?: string };
  benchmark: { human_cost_per_ticket_usd_low: number; human_cost_per_ticket_usd_high: number; source?: string };
}

function loadPricing(): Pricing {
  return JSON.parse(fs.readFileSync(PRICING_FILE, "utf8")) as Pricing;
}

// --- ElevenLabs call data, cached so the dashboard is refresh-safe ---

export interface VoiceCall {
  started_at: string;
  duration_secs: number;
  source: string; // widget | phone | ...
  language: string;
  status: string;
  successful: string;
  title: string | null;
  cost_credits: number | null; // REAL charge from the conversation's billing metadata
}

interface VoiceUsage {
  calls: number;
  total_minutes: number;
  avg_call_minutes: number;
  total_credits: number;
  recent_calls: VoiceCall[];
}

// Per-conversation detail fetches are ~40 requests, so cache for 5 minutes —
// a dashboard left open (or refreshed on stage) must never hammer the API.
const VOICE_CACHE_MS = 5 * 60_000;
const DETAIL_LIMIT = 50;

let voiceCache: { at: number; data: VoiceUsage | null } | null = null;

async function fetchVoiceUsage(): Promise<VoiceUsage | null> {
  const key = process.env.ELEVENLABS_API_KEY;
  const agentId = process.env.ELEVENLABS_AGENT_ID;
  if (!key || !agentId) return null;
  if (voiceCache && Date.now() - voiceCache.at < VOICE_CACHE_MS) return voiceCache.data;
  try {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversations?agent_id=${agentId}&page_size=100`,
      { headers: { "xi-api-key": key } },
    );
    if (!res.ok) throw new Error(`ElevenLabs ${res.status}`);
    const body = (await res.json()) as {
      conversations?: {
        conversation_id: string;
        start_time_unix_secs?: number;
        call_duration_secs?: number;
        status?: string;
        call_successful?: string;
        main_language?: string;
        conversation_initiation_source?: string;
        call_summary_title?: string | null;
      }[];
    };
    const convs = body.conversations ?? [];
    const totalSecs = convs.reduce((sum, c) => sum + (c.call_duration_secs ?? 0), 0);

    // Real per-call charges live only on the conversation detail (metadata.cost,
    // in credits). Fetch the most recent DETAIL_LIMIT concurrently; a failed
    // detail leaves that row's charge null rather than sinking the page.
    const recent = convs.slice(0, DETAIL_LIMIT);
    const costs = await Promise.all(
      recent.map(async (c) => {
        try {
          const r = await fetch(`https://api.elevenlabs.io/v1/convai/conversations/${c.conversation_id}`, {
            headers: { "xi-api-key": key },
          });
          if (!r.ok) return null;
          const detail = (await r.json()) as { metadata?: { cost?: number } };
          return detail.metadata?.cost ?? null;
        } catch {
          return null;
        }
      }),
    );

    const recentCalls: VoiceCall[] = recent.map((c, i) => ({
      started_at: new Date((c.start_time_unix_secs ?? 0) * 1000).toISOString(),
      duration_secs: c.call_duration_secs ?? 0,
      source: c.conversation_initiation_source ?? "?",
      language: c.main_language ?? "?",
      status: c.status ?? "?",
      successful: c.call_successful ?? "unknown",
      title: c.call_summary_title ?? null,
      cost_credits: costs[i],
    }));

    const data: VoiceUsage = {
      calls: convs.length,
      total_minutes: round(totalSecs / 60, 1),
      avg_call_minutes: convs.length > 0 ? round(totalSecs / 60 / convs.length, 2) : 0,
      total_credits: costs.reduce((sum: number, c) => sum + (c ?? 0), 0),
      recent_calls: recentCalls,
    };
    voiceCache = { at: Date.now(), data };
    return data;
  } catch {
    // Voice metrics are additive color, not load-bearing — the dashboard
    // renders without them rather than erroring the whole page.
    voiceCache = { at: Date.now(), data: null };
    return null;
  }
}

function round(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

// --- The aggregate ---

function tokenTotals(events: ReturnType<typeof readAudit>) {
  // Brains emit two token-field shapes: Claude uses input_tokens/output_tokens,
  // the OpenAI-style providers (Groq, Sarvam) use prompt_tokens/completion_tokens.
  const usage = events.filter((e) => e.type === "brain.usage");
  let tokensIn = 0;
  let tokensOut = 0;
  const byModel: Record<string, number> = {};
  for (const e of usage) {
    const d = (e.data ?? {}) as Record<string, unknown>;
    tokensIn += Number(d.input_tokens ?? d.prompt_tokens ?? 0);
    tokensOut += Number(d.output_tokens ?? d.completion_tokens ?? 0);
    const model = String(d.model ?? "unknown");
    byModel[model] = (byModel[model] ?? 0) + 1;
  }
  return { calls: usage.length, tokensIn, tokensOut, byModel };
}

export async function dashboardMetrics(period: "today" | "all" = "all"): Promise<Record<string, unknown>> {
  const pricing = loadPricing();
  const allEvents = readAudit();
  const since = period === "today" ? new Date(new Date().setHours(0, 0, 0, 0)) : null;
  // Activity totals follow the period filter; the per-call pricing basis always
  // uses all-time averages so the headline $/call never collapses to zero on a
  // fresh morning with no calls yet.
  const events = since ? allEvents.filter((e) => new Date(e.ts) >= since) : allEvents;
  const count = (type: string) => events.filter((e) => e.type === type).length;

  const llm = tokenTotals(events);
  const llmAll = since ? tokenTotals(allEvents) : llm;

  const denialReasons: Record<string, number> = {};
  for (const e of events.filter((ev) => ev.type === "guard.denied")) {
    const check = String((e.data as Record<string, unknown>)?.hard_check ?? "judge");
    denialReasons[check] = (denialReasons[check] ?? 0) + 1;
  }

  const cases = count("case.received");
  const casesAll = since ? allEvents.filter((e) => e.type === "case.received").length : cases;
  const refunds = count("money.refund");
  const voiceAll = await fetchVoiceUsage();
  // Today's calls are by definition the most recent, so filtering the
  // DETAIL_LIMIT newest detail rows is accurate at demo scale.
  const voice =
    voiceAll && since
      ? (() => {
          const rows = voiceAll.recent_calls.filter((c) => new Date(c.started_at) >= since);
          const secs = rows.reduce((sum, c) => sum + c.duration_secs, 0);
          return {
            calls: rows.length,
            total_minutes: round(secs / 60, 1),
            avg_call_minutes: rows.length > 0 ? round(secs / 60 / rows.length, 2) : 0,
            total_credits: rows.reduce((sum, c) => sum + (c.cost_credits ?? 0), 0),
            recent_calls: rows,
          };
        })()
      : voiceAll;

  const llmUsd = (llm.tokensIn / 1e6) * pricing.llm.usd_per_mtok_in + (llm.tokensOut / 1e6) * pricing.llm.usd_per_mtok_out;
  const voiceUsd = voice ? voice.total_minutes * pricing.voice.usd_per_min : null;
  const telephonyInr = voice ? voice.total_minutes * pricing.telephony.inr_per_min : null;
  const dodoFeesUsd = refunds * pricing.payments.usd_fee_per_refund;

  // The pitch number: what ONE resolved call costs, built from this
  // deployment's real all-time averages (call length, tokens per case) at
  // rate-card prices. Refund fee shown separately — it only applies when
  // money moves.
  const avgCallMin = voiceAll && voiceAll.calls > 0 ? voiceAll.avg_call_minutes : null;
  const avgTokensIn = casesAll > 0 ? llmAll.tokensIn / casesAll : 0;
  const avgTokensOut = casesAll > 0 ? llmAll.tokensOut / casesAll : 0;
  const perCallLlmUsd = (avgTokensIn / 1e6) * pricing.llm.usd_per_mtok_in + (avgTokensOut / 1e6) * pricing.llm.usd_per_mtok_out;
  const perCallVoiceUsd = avgCallMin !== null ? avgCallMin * pricing.voice.usd_per_min : null;
  const perCallTelephonyUsd =
    avgCallMin !== null ? avgCallMin * pricing.telephony.inr_per_min * pricing.telephony.usd_per_inr : null;
  const perCallSubtotal = perCallLlmUsd + (perCallVoiceUsd ?? 0) + (perCallTelephonyUsd ?? 0);

  return {
    generated_at: new Date().toISOString(),
    period,
    pricing,
    per_call: {
      avg_call_minutes: avgCallMin,
      avg_tokens_in: Math.round(avgTokensIn),
      avg_tokens_out: Math.round(avgTokensOut),
      llm_usd: round(perCallLlmUsd, 4),
      voice_usd: perCallVoiceUsd !== null ? round(perCallVoiceUsd, 4) : null,
      telephony_usd: perCallTelephonyUsd !== null ? round(perCallTelephonyUsd, 4) : null,
      subtotal_usd: round(perCallSubtotal, 4),
      with_refund_fee_usd: round(perCallSubtotal + pricing.payments.usd_fee_per_refund, 4),
      human_benchmark_usd: [
        pricing.benchmark.human_cost_per_ticket_usd_low,
        pricing.benchmark.human_cost_per_ticket_usd_high,
      ],
    },
    totals: {
      cases,
      llm: {
        calls: llm.calls,
        tokens_in: llm.tokensIn,
        tokens_out: llm.tokensOut,
        by_model: llm.byModel,
        usd: round(llmUsd, 4),
      },
      voice: voice
        ? {
            calls: voice.calls,
            total_minutes: voice.total_minutes,
            credits: voice.total_credits,
            usd_actual: round(voice.total_credits * (pricing.voice.usd_per_credit ?? 0), 2),
            usd_at_rate: round(voiceUsd ?? 0, 2),
            recent_calls: voice.recent_calls,
          }
        : null,
      telephony_estimate: voice
        ? {
            minutes: voice.total_minutes,
            inr: round(telephonyInr ?? 0, 2),
            usd: round((telephonyInr ?? 0) * pricing.telephony.usd_per_inr, 2),
          }
        : null,
      payments: { refunds_succeeded: refunds, refunds_blocked: count("money.failed"), fees_usd: round(dodoFeesUsd, 2) },
      helpdesk: { notes_added: count("freshdesk.note_added"), escalations: count("escalation.raised") },
      guard: {
        approved: count("guard.approved"),
        denied: count("guard.denied"),
        denial_reasons: denialReasons,
      },
      outcomes: {
        refunds_completed: refunds,
        returns_requested: count("return.requested"),
        escalated_to_human: count("escalation.raised"),
        otp_sent: count("otp.sent"),
        otp_lockouts: count("otp.locked"),
      },
    },
  };
}
