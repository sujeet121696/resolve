// The Brain — the pluggable LLM seam.
//
// Both agents (Resolution + Policy-Guard judgment call) go through this
// interface, so the LLM provider is swappable via the BRAIN env var:
//   BRAIN=mock    → deterministic rules, zero cost (local development default)
//   BRAIN=auto    → groq primary, sarvam fallback (everyday dev default; sarvam
//                   replaced gemini as fallback Sept 2026 — 20/20 on the Step 3
//                   harness at p50 3.2 s vs gemini's 20-requests/day free tier)
//   BRAIN=auto-sarvam → sarvam primary, groq fallback (the DEMO-DAY setting:
//                   Sarvam is a hackathon sponsor, so the sponsor model makes
//                   the guarded decisions live; Groq stays as the safety net)
//   BRAIN=groq    → Groq free tier — fast: measured p50 1.6 s for the full
//                   propose+judge double call (Step 3 harness, Aug 21)
//   BRAIN=gemini  → Google AI Studio — free tier is 20 req/day and slow
//                   (2–13 s per call), so it's the fallback, not the primary
//   BRAIN=sarvam  → Sarvam AI (Indian model, sarvam-105b-conversations) —
//                   measured ~1.8 s/call Sept 2026, JSON mode works
//   BRAIN=claude  → real Anthropic API (kept as the production path)
//
// Note: the guard's HARD checks (auto-limit, idempotency, verified flag) are
// plain code in policy-guard.ts and run regardless of brain — only the
// judgment call is LLM-backed.

import type { CaseFacts, GuardVerdict, ResolutionProposal } from "./types.js";
import { emitEvent } from "./events.js";
import { mockBrain } from "./brain/mock.js";
import { claudeBrain } from "./brain/claude.js";
import { geminiBrain } from "./brain/gemini.js";
import { groqBrain } from "./brain/groq.js";
import { sarvamBrain } from "./brain/sarvam.js";

export interface Brain {
  /** Which implementation is live — shown on the ops view. */
  name: "mock" | "groq" | "gemini" | "sarvam" | "claude";
  /** Resolution agent: facts in, proposed action out. */
  propose(facts: CaseFacts): Promise<ResolutionProposal>;
  /** Policy-Guard judgment call: proposal in, verdict out. */
  judge(proposal: ResolutionProposal): Promise<GuardVerdict>;
}

// Tries the primary; any error (rate limit, outage) retries once on the
// backup. Both brains emit their own ops events, so a fallback is visible on
// the ops view as a groq error followed by gemini activity.
function withFallback(primary: Brain, backup: Brain): Brain {
  return {
    name: primary.name,
    async propose(facts) {
      try {
        return await primary.propose(facts);
      } catch (err) {
        emitEvent("brain.fallback", `${primary.name} propose failed → ${backup.name}: ${(err as Error).message.slice(0, 120)}`);
        return backup.propose(facts);
      }
    },
    async judge(proposal) {
      try {
        return await primary.judge(proposal);
      } catch (err) {
        emitEvent("brain.fallback", `${primary.name} judge failed → ${backup.name}: ${(err as Error).message.slice(0, 120)}`);
        return backup.judge(proposal);
      }
    },
  };
}

export function getBrain(): Brain {
  const choice = (process.env.BRAIN ?? "mock").toLowerCase();
  if (choice === "auto") return withFallback(groqBrain, sarvamBrain);
  if (choice === "auto-sarvam") return withFallback(sarvamBrain, groqBrain);
  if (choice === "claude") return claudeBrain;
  if (choice === "gemini") return geminiBrain;
  if (choice === "sarvam") return sarvamBrain;
  if (choice === "groq") return groqBrain;
  if (choice !== "mock") {
    console.warn(`Unknown BRAIN="${choice}" — falling back to mock`);
  }
  return mockBrain;
}
