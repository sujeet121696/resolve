// Resolution agent — reads the case facts and proposes an action.
// The LLM side lives behind the Brain seam (src/brain.ts): mock for free local
// dev, Claude from Step 3. This module stays the same either way.

import type { CaseFacts, ResolutionProposal } from "../types.js";
import { getBrain } from "../brain.js";

export async function proposeResolution(facts: CaseFacts): Promise<ResolutionProposal> {
  return getBrain().propose(facts);
}
