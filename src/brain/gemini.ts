// Gemini brain — the free real-LLM brain (Google AI Studio free tier).
// Chosen over the Anthropic API purely on cost for the hackathon; the Brain
// seam means swapping back is a one-line env change.
//
// Both calls use structured output (responseSchema), so responses parse
// reliably. The judge re-states the hard rules in the prompt — defense in
// depth on top of policy-guard.ts, same as the mock brain re-checks them.

import type { Brain } from "../brain.js";
import type { CaseFacts, GuardVerdict, ResolutionProposal } from "../types.js";
import { emitEvent } from "../events.js";

const MODEL = process.env.GEMINI_MODEL ?? "gemini-3.6-flash";
const AUTO_LIMIT = Number(process.env.AUTO_REFUND_LIMIT ?? 500_000);
const CONFIDENCE_FLOOR = 0.7;

async function generate<T>(prompt: string, schema: Record<string, unknown>): Promise<T> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set — add it to .env or use BRAIN=mock");

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: schema,
          temperature: 0.1,
          // Latency is the demo constraint (beat-4 caller silence). The hard
          // policy rules are enforced in plain code by policy-guard.ts, so the
          // LLM judgment call doesn't need extended thinking.
          thinkingConfig: { thinkingLevel: "minimal" },
        },
      }),
    },
  );
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned no text candidate");
  return JSON.parse(text) as T;
}

export const geminiBrain: Brain = {
  name: "gemini",

  async propose(facts: CaseFacts): Promise<ResolutionProposal> {
    const out = await generate<{ action: ResolutionProposal["action"]; summary: string }>(
      `You are the Resolution agent of a customer support system. Given the
structured case facts below, propose the single most appropriate action.

Rules:
- action must be one of: refund, plan_change, escalate, refuse
- refund only makes sense for a refund claim with a payment attached
- when facts look incomplete or contradictory, prefer escalate
- summary: one short line describing the proposed action for an audit log

Case facts JSON:
${JSON.stringify(facts, null, 2)}`,
      {
        type: "object",
        properties: {
          action: { type: "string", enum: ["refund", "plan_change", "escalate", "refuse"] },
          summary: { type: "string" },
        },
        required: ["action", "summary"],
      },
    );
    const proposal: ResolutionProposal = { action: out.action, facts, summary: out.summary };
    emitEvent("agent.resolution.proposed", proposal.summary, { brain: "gemini" });
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

decision: approve or deny. reason: one short line for the audit log.

Proposed action: ${proposal.action}
Summary: ${proposal.summary}
Case facts JSON:
${JSON.stringify(facts, null, 2)}`,
      {
        type: "object",
        properties: {
          decision: { type: "string", enum: ["approve", "deny"] },
          reason: { type: "string" },
        },
        required: ["decision", "reason"],
      },
    );
    const verdict: GuardVerdict = { decision: out.decision, reason: `[gemini] ${out.reason}` };
    emitEvent(
      verdict.decision === "approve" ? "guard.approved" : "guard.denied",
      verdict.reason,
      { brain: "gemini" },
    );
    return verdict;
  },
};
