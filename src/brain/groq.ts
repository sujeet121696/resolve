// Groq brain — the free fast-LLM brain (console.groq.com free tier).
// Chosen after Gemini's 2026 free tier proved unusable (20 requests/day on the
// only model new keys can call). Groq's free tier allows ~1k requests/day and
// its inference speed is the best fit for the beat-4 latency constraint.
//
// OpenAI-compatible chat completions endpoint with JSON mode. The judge
// re-states the hard rules in the prompt — defense in depth on top of
// policy-guard.ts, same as the other brains.

import type { Brain } from "../brain.js";
import type { CaseFacts, GuardVerdict, ResolutionProposal } from "../types.js";
import { emitEvent } from "../events.js";

const MODEL = process.env.GROQ_MODEL ?? "openai/gpt-oss-120b";
const AUTO_LIMIT = Number(process.env.AUTO_REFUND_LIMIT ?? 500_000);
const CONFIDENCE_FLOOR = 0.7;

async function generate<T>(prompt: string): Promise<T> {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("GROQ_API_KEY not set — add it to .env or use BRAIN=mock");

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0.1,
      // gpt-oss is a reasoning model; low effort keeps the beat-4 pause short.
      // Groq ignores this field for non-reasoning models.
      reasoning_effort: "low",
    }),
  });
  if (!res.ok) throw new Error(`Groq ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error("Groq returned no message content");
  // Token counts land in the audit trail so cost per call is measured, not
  // estimated (`npm run audit` totals them).
  if (data.usage) {
    emitEvent(
      "brain.usage",
      `${MODEL}: ${data.usage.prompt_tokens ?? 0} in / ${data.usage.completion_tokens ?? 0} out`,
      { model: MODEL, ...data.usage },
    );
  }
  return JSON.parse(text) as T;
}

export const groqBrain: Brain = {
  name: "groq",

  async propose(facts: CaseFacts): Promise<ResolutionProposal> {
    const out = await generate<{ action: ResolutionProposal["action"]; summary: string }>(
      `You are the Resolution agent of a customer support system. Given the
structured case facts below, propose the single most appropriate action.

Rules:
- action must be one of: refund, plan_change, escalate, refuse
- refund only makes sense for a refund claim with a payment attached
- when facts look incomplete or contradictory, prefer escalate
- summary: one short line describing the proposed action for an audit log

Respond with JSON only, exactly this shape:
{"action": "refund" | "plan_change" | "escalate" | "refuse", "summary": "..."}

Case facts JSON:
${JSON.stringify(facts, null, 2)}`,
    );
    const proposal: ResolutionProposal = { action: out.action, facts, summary: out.summary };
    emitEvent("agent.resolution.proposed", proposal.summary, { brain: "groq" });
    return proposal;
  },

  async judge(proposal: ResolutionProposal): Promise<GuardVerdict> {
    const { facts } = proposal;
    const out = await generate<{ decision: "approve" | "deny"; reason: string }>(
      `You are the Policy-Guard of a customer support system. You independently
judge a proposed action. You see ONLY structured facts, never the conversation.

Policy (violations MUST be denied):
- amounts are in minor units; anything above ${AUTO_LIMIT} is over the
  auto-approve limit and must be denied (a human handles it)
- resolution_confidence below ${CONFIDENCE_FLOOR} must be denied
- a refund proposal without a payment_id must be denied
- otherwise, weigh customer history: long tenure and few prior refunds favor
  approval; many recent refunds deserve skepticism

Respond with JSON only, exactly this shape:
{"decision": "approve" | "deny", "reason": "one short line for the audit log"}

Proposed action: ${proposal.action}
Summary: ${proposal.summary}
Case facts JSON:
${JSON.stringify(facts, null, 2)}`,
    );
    const verdict: GuardVerdict = { decision: out.decision, reason: `[groq] ${out.reason}` };
    emitEvent(
      verdict.decision === "approve" ? "guard.approved" : "guard.denied",
      verdict.reason,
      { brain: "groq" },
    );
    return verdict;
  },
};
