// Sarvam brain — Sarvam AI's hosted model (dashboard.sarvam.ai), the Indian
// LLM option behind the same seam as Groq. OpenAI-compatible chat completions
// with JSON mode, verified Sept 2026: sarvam-105b-conversations answers the
// propose/judge prompts in ~1.8 s with no reasoning preamble. The plain
// sarvam-105b variant is a reasoning model that spends hundreds of tokens
// thinking before the JSON — keep the conversations model unless that changes.
//
// The judge re-states the hard rules in the prompt — defense in depth on top
// of policy-guard.ts, same as the other brains.

import type { Brain } from "../brain.js";
import type { CaseFacts, GuardVerdict, ResolutionProposal } from "../types.js";
import { emitEvent } from "../events.js";

const MODEL = process.env.SARVAM_MODEL ?? "sarvam-105b-conversations";
const AUTO_LIMIT = Number(process.env.AUTO_REFUND_LIMIT ?? 500_000);
const CONFIDENCE_FLOOR = 0.7;

async function generate<T>(prompt: string): Promise<T> {
  const key = process.env.SARVAM_API_KEY;
  if (!key) throw new Error("SARVAM_API_KEY not set — add it to .env or use BRAIN=mock");

  const res = await fetch("https://api.sarvam.ai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0.1,
      // Caps the reasoning variant if SARVAM_MODEL is overridden; the
      // conversations model answers in well under 100 tokens either way.
      reasoning_effort: "low",
      max_tokens: 1024,
    }),
  });
  if (!res.ok) throw new Error(`Sarvam ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error("Sarvam returned no message content");
  if (data.usage) {
    emitEvent(
      "brain.usage",
      `${MODEL}: ${data.usage.prompt_tokens ?? 0} in / ${data.usage.completion_tokens ?? 0} out`,
      { model: MODEL, ...data.usage },
    );
  }
  return JSON.parse(text) as T;
}

export const sarvamBrain: Brain = {
  name: "sarvam",

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
    emitEvent("agent.resolution.proposed", proposal.summary, { brain: "sarvam" });
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
    const verdict: GuardVerdict = { decision: out.decision, reason: `[sarvam] ${out.reason}` };
    emitEvent(
      verdict.decision === "approve" ? "guard.approved" : "guard.denied",
      verdict.reason,
      { brain: "sarvam" },
    );
    return verdict;
  },
};
