// Claude brain — the real thing (Anthropic Messages API, needs ANTHROPIC_API_KEY).
// Made the production default (BRAIN=auto-claude) Sept 2026: Claude judges the
// money-moving decision live, with Sarvam then Groq as free-tier safety nets
// if the Claude call errors or rate-limits (see brain.ts's withFallback chain).
//
// Same shape as the other brains (plain fetch, no SDK, JSON-only prompt) so
// swapping the primary provider never touches resolve-case.ts or the guard.

import type { Brain } from "../brain.js";
import type { CaseFacts, GuardVerdict, ResolutionProposal } from "../types.js";
import { emitEvent } from "../events.js";
import { limitFor } from "../policy-config.js";

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5";
const CONFIDENCE_FLOOR = 0.7;

// Claude has no OpenAI-style json_object mode — the prompt demands JSON only,
// and this strips code-fence wrapping or stray prose the model adds anyway.
function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`Claude response had no JSON object: ${text.slice(0, 200)}`);
  }
  return body.slice(start, end + 1);
}

async function generate<T>(prompt: string): Promise<T> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not set — add it to .env or use BRAIN=mock");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 400,
      // No `temperature` override: Claude 5-family models reject a custom
      // temperature in their default mode ("temperature is deprecated for
      // this mode") — the JSON-only prompt doesn't need sampling control
      // anyway, so we just take the model's default.
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Claude ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as {
    content?: { type: string; text?: string }[];
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const text = data.content?.find((b) => b.type === "text")?.text;
  if (!text) throw new Error("Claude returned no text content");
  if (data.usage) {
    emitEvent(
      "brain.usage",
      `${MODEL}: ${data.usage.input_tokens ?? 0} in / ${data.usage.output_tokens ?? 0} out`,
      { model: MODEL, ...data.usage },
    );
  }
  return JSON.parse(extractJson(text)) as T;
}

export const claudeBrain: Brain = {
  name: "claude",

  async propose(facts: CaseFacts): Promise<ResolutionProposal> {
    const out = await generate<{ action: ResolutionProposal["action"]; summary: string }>(
      `You are the Resolution agent of a customer support system. Given the
structured case facts below, propose the single most appropriate action.

Rules:
- action must be one of: refund, plan_change, escalate, refuse
- refund only makes sense for a refund claim with a payment attached
- when facts look incomplete or contradictory, prefer escalate
- summary: one short line describing the proposed action for an audit log

Respond with JSON only, exactly this shape, no other text:
{"action": "refund" | "plan_change" | "escalate" | "refuse", "summary": "..."}

Case facts JSON:
${JSON.stringify(facts, null, 2)}`,
    );
    const proposal: ResolutionProposal = { action: out.action, facts, summary: out.summary };
    emitEvent("agent.resolution.proposed", proposal.summary, { brain: "claude" });
    return proposal;
  },

  async judge(proposal: ResolutionProposal): Promise<GuardVerdict> {
    const { facts } = proposal;
    // The ceiling is per-currency (limitFor, shared with the guard's hard
    // check) so the model reasons about the number the code actually enforces
    // — a flat limit here read as ₹5,000 for INR but $5,000 for USD.
    const limit = limitFor(facts.currency);
    const limitLine =
      limit === undefined
        ? `- no auto-approve ceiling is configured for currency "${facts.currency}" — any money-moving action must be denied (a human handles it)`
        : `- amounts are in minor units; anything above ${limit} ${facts.currency} is over the
  auto-approve limit and must be denied (a human handles it)`;
    const out = await generate<{ decision: "approve" | "deny"; reason: string }>(
      `You are the Policy-Guard of a customer support system. You independently
judge a proposed action. You see ONLY structured facts, never the conversation.

Policy (violations MUST be denied):
${limitLine}
- resolution_confidence below ${CONFIDENCE_FLOOR} must be denied
- a refund proposal without a payment_id must be denied
- otherwise, weigh customer history: long tenure and few prior refunds favor
  approval; many recent refunds deserve skepticism

Respond with JSON only, exactly this shape, no other text:
{"decision": "approve" | "deny", "reason": "one short line for the audit log"}

Proposed action: ${proposal.action}
Summary: ${proposal.summary}
Case facts JSON:
${JSON.stringify(facts, null, 2)}`,
    );
    const verdict: GuardVerdict = { decision: out.decision, reason: `[claude] ${out.reason}` };
    emitEvent(
      verdict.decision === "approve" ? "guard.approved" : "guard.denied",
      verdict.reason,
      { brain: "claude" },
    );
    return verdict;
  },
};
