// Claude brain — the real thing. Implemented in Step 3 (needs ANTHROPIC_API_KEY).
//
// Step 3 plan: two @anthropic-ai/sdk calls (Resolution agent, then the guard's
// judgment call), structured facts in / short verdicts out, and the beat-4
// latency measured over 10 runs (p50/p95). Until then, BRAIN=mock does the job.

import type { Brain } from "../brain.js";

function notReady(): never {
  throw new Error(
    "Claude brain not implemented yet (Step 3). " +
      "Set BRAIN=mock in .env for free local testing, " +
      "or wait for Step 3 (needs ANTHROPIC_API_KEY).",
  );
}

export const claudeBrain: Brain = {
  name: "claude",
  async propose() {
    notReady();
  },
  async judge() {
    notReady();
  },
};
