// Mock brain — deterministic stand-in for Claude. Zero API cost.
//
// Encodes the same rules the real prompts will express, so the whole pipeline
// (Steps 2, 4–8) can be built and tested offline:
//   Ravi  (₹1,499, good history, high confidence)  → refund approved
//   Priya (₹18,999, over limit, low confidence)    → denied → escalation path
//
// Each call sleeps ~1s to imitate real LLM latency, so the voice flow's
// silence handling gets exercised even in mock mode. The REAL number still
// comes from Step 3 on BRAIN=claude — never quote mock timings.

import type { Brain } from "../brain.js";
import type { CaseFacts, GuardVerdict, ResolutionProposal } from "../types.js";
import { emitEvent } from "../events.js";

// Minor units (paise): ₹5,000 auto-approve ceiling unless overridden.
const AUTO_LIMIT = Number(process.env.AUTO_REFUND_LIMIT ?? 500_000);
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

    let verdict: GuardVerdict;
    if (facts.amount > AUTO_LIMIT) {
      verdict = {
        decision: "deny",
        reason: `[mock] amount ${facts.amount} exceeds auto-approve limit ${AUTO_LIMIT}`,
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
