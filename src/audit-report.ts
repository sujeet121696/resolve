// `npm run audit` — reads data/audit.jsonl and prints the trail as a judge
// would want to read it: what was proposed, what the guard ruled, what money
// actually moved, and every attempt that was refused.
//
// Deliberately a CLI, not an HTTP endpoint: the trail contains customer emails
// and payment ids, and the server is exposed through a public ngrok tunnel
// during demos.

import "dotenv/config";
import { readAudit } from "./audit.js";

const events = readAudit();

if (events.length === 0) {
  console.log("No audit trail yet — data/audit.jsonl is empty or missing.");
  process.exit(0);
}

const counts = new Map<string, number>();
for (const e of events) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);

const refunds = events.filter((e) => e.type === "money.refund");
const denials = events.filter((e) => e.type === "guard.denied");
const escalations = events.filter((e) => e.type === "escalation.raised");
const unauthorized = events.filter((e) => e.type === "tools.unauthorized");
const lockouts = events.filter((e) => e.type === "otp.locked");

const first = events[0];
const last = events[events.length - 1];

console.log(`\nResolve — audit trail`);
console.log(`${events.length} events from ${first.ts} to ${last.ts}\n`);

console.log(`Money moved       ${refunds.length} refund(s)`);
for (const r of refunds) console.log(`  · ${r.ts}  ${r.message}`);

console.log(`\nGuard denials     ${denials.length}`);
for (const d of denials) console.log(`  · ${d.ts}  ${d.message}`);

console.log(`\nEscalated to human ${escalations.length}`);
console.log(`OTP lockouts       ${lockouts.length}`);
console.log(`Rejected /tools calls (bad token) ${unauthorized.length}`);

// Brain tokens. A case costs TWO LLM calls (propose + judge) only when it
// reaches the judgment stage — a hard-check denial short-circuits after
// propose, so calls-per-case varies. Cases are counted from case.received, and
// prices come from .env rather than hardcoded, so the figure always traces to a
// provider's pricing page.
const usage = events.filter((e) => e.type === "brain.usage");
if (usage.length > 0) {
  const sum = (field: string) =>
    usage.reduce((total, e) => total + Number((e.data as Record<string, unknown>)?.[field] ?? 0), 0);
  const tokensIn = sum("prompt_tokens");
  const tokensOut = sum("completion_tokens");
  const cases = events.filter((e) => e.type === "case.received").length;

  console.log(`\nBrain usage`);
  console.log(`  ${usage.length} LLM call(s) across ${cases} case(s)`);
  console.log(`  ${tokensIn} tokens in / ${tokensOut} tokens out`);
  if (cases > 0) {
    console.log(
      `  per case: ${Math.round(tokensIn / cases)} in / ${Math.round(tokensOut / cases)} out` +
        ` · ${(usage.length / cases).toFixed(1)} LLM calls`,
    );
  }

  const priceIn = Number(process.env.LLM_PRICE_PER_MTOK_IN);
  const priceOut = Number(process.env.LLM_PRICE_PER_MTOK_OUT);
  if (Number.isFinite(priceIn) && Number.isFinite(priceOut)) {
    const cost = (tokensIn / 1e6) * priceIn + (tokensOut / 1e6) * priceOut;
    console.log(
      `  cost: $${cost.toFixed(6)} total` + (cases > 0 ? ` · $${(cost / cases).toFixed(6)}/case` : ""),
    );
  } else {
    console.log(`  cost: set LLM_PRICE_PER_MTOK_IN / _OUT in .env (from the provider's pricing page) to price this`);
  }
}

console.log(`\nEvent counts by type`);
for (const [type, n] of [...counts].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${type}`);
}
console.log();
