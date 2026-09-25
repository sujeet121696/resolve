// Mock brain — deterministic stand-in for Claude. Zero API cost.
//
// Encodes the same rules the real prompts will express, so the whole pipeline
// (Steps 2, 4–8) can be built and tested offline:
//   Sujeet  (₹1,499, good history, high confidence)  → refund approved
//   Priya (₹18,999, over limit, low confidence)    → denied → escalation path
//
// Each call sleeps ~1s to imitate real LLM latency, so the voice flow's
// silence handling gets exercised even in mock mode. The REAL number still
// comes from Step 3 on BRAIN=claude — never quote mock timings.

import type { Brain } from "../brain.js";
import type { CaseFacts, GuardVerdict, ResolutionProposal } from "../types.js";
import { emitEvent } from "../events.js";
import { limitFor } from "../policy-config.js";

const CONFIDENCE_FLOOR = 0.7;

const thinkingDelay = () =>
  new Promise((r) => setTimeout(r, 800 + Math.random() * 400));

export const mockBrain: Brain = {
  name: "mock",

  async propose(facts: CaseFacts): Promise<ResolutionProposal> {
    await thinkingDelay();
    const action =
      facts.claim_type === "refund" || facts.claim_type === "plan_change"
        ? facts.claim_type
        : "escalate";
    const proposal: ResolutionProposal = {
      action,
      facts,
      summary: `[mock] ${action} of ${facts.amount} ${facts.currency} for order ${facts.order_id} (ticket ${facts.ticket_id})`,
    };
    emitEvent("agent.resolution.proposed", proposal.summary, { brain: "mock" });
    return proposal;
  },

  async judge(proposal: ResolutionProposal): Promise<GuardVerdict> {
    await thinkingDelay();
    const { facts } = proposal;

    // Per-currency ceiling, shared with the guard's hard check (limitFor in
    // policy-config.ts) — a flat number here read as ₹5,000 but also $5,000.
    const limit = limitFor(facts.currency);

    let verdict: GuardVerdict;
    if (limit === undefined) {
      verdict = {
        decision: "deny",
        reason: `[mock] no auto-approve ceiling configured for currency "${facts.currency}"`,
        hard_check_failed: "unknown_currency",
      };
    } else if (facts.amount > limit) {
      verdict = {
        decision: "deny",
        reason: `[mock] amount ${facts.amount} ${facts.currency} exceeds auto-approve limit ${limit}`,
        hard_check_failed: "auto_limit",
      };
    } else if (facts.resolution_confidence < CONFIDENCE_FLOOR) {
      verdict = {
        decision: "deny",
        reason: `[mock] confidence ${facts.resolution_confidence} below floor ${CONFIDENCE_FLOOR}`,
      };
    } else {
      verdict = {
        decision: "approve",
        reason: `[mock] within limit, confidence ${facts.resolution_confidence}, history clean enough`,
      };
    }

    emitEvent(
      verdict.decision === "approve" ? "guard.approved" : "guard.denied",
      verdict.reason,
      { brain: "mock" },
    );
    return verdict;
  },
};
