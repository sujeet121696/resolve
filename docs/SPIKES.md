# Verification Spikes — Go/No-Go Gate

> Run these BEFORE committing build time. No project code needed — dashboards and existing tools only.
> Record actual numbers here as you go; the cost-per-call figure in the pitch needs them.

## Step 0 — Prerequisites (accounts, ~30 min)

| # | Account | Where | Cost |
|---|---|---|---|
| 1 | ElevenLabs | elevenlabs.io → sign up free | Free tier ≈ 10 min agent audio — enough for this spike only |
| 2 | Dodo Payments (test mode) | dodopayments.com → sign up, stay in test mode | Free |
| 3 | Anthropic API | console.anthropic.com | Pay-per-use (few ₹ for spikes) |
| 4 | Freshdesk trial | freshdesk.com → free trial | Free (21-day trial — time its start near the hackathon if possible) |

---

## Spike 1 — ElevenLabs voice: Hindi quality + tool-call latency (~1–2 hrs)

**Question:** Does the ASR understand OUR Hindi, and how long is the silence when a tool fires?

1. ElevenLabs dashboard → **Agents** → create an agent (no code — all in UI).
2. System prompt: simple support persona, respond in the caller's language (Hindi/English). Pick a multilingual voice/model.
3. **Script 10 Hindi test phrases BEFORE testing** (free tier burns fast): order number, "mera order toot ke aaya", amounts (₹1,499), yes/no confirmations, an English-Hindi mixed sentence.
4. Talk to the agent via the built-in widget. Score each phrase: understood / misheard / failed.
5. Add one **webhook tool** pointing at https://webhook.site (free, no code) — e.g. "look up order status." Ask a question that triggers it. Stopwatch the silence between your question and the agent speaking.
6. Repeat the tool call 5×, note worst-case latency.

**Record here (run Aug 20, 2026):**
- Hindi phrases understood: formal 10-phrase scoring SKIPPED (user's call — working well enough for hackathon purposes)
- Observed evidence instead: mixed Hinglish query understood first try; spoken digits ("one two three four five") correctly extracted to `12345` in tool call; agent replied in fluent natural Hindi; handled empty webhook response gracefully (offered retry instead of hallucinating a status)
- Tool-call silence: not stopwatched — felt acceptable in test (re-measure with real orchestrator during build)
- Agent built in ElevenLabs new builder UI ("Architect") · webhook tool JSON breaks on unescaped quotes in descriptions — keep tool/param descriptions quote-free
- **VERDICT: PASS (informal)** — Hindi + tool-calling + digit extraction all confirmed working

**PASS:** ≥8/10 Hindi understood AND tool silence ≤ ~3s (or clearly maskable with filler speech).
**PARTIAL:** Hindi weak but English solid → demo English-first, Hindi as one scripted beat.
**FAIL:** latency 5s+ and unmaskable → voice demo unsafe → see decision gate.

---

## Spike 2 — Dodo Payments: test-mode refund via MCP (~1 hr)

**Question:** Can an agent actually move (test) money through Dodo's MCP server end-to-end?

1. Dodo dashboard (test mode) → create a test product → complete a test-mode checkout so a **payment exists to refund**.
2. Find Dodo's MCP server in their docs (they ship one) and attach it to **Claude Code** via `/mcp` — Claude Code is our MCP client, no code written.
3. List the tools it exposes. Confirm a refund-creation tool exists.
4. Ask Claude to refund that test payment via the MCP tool.
5. Verify the refund appears in the Dodo dashboard.

**Record here (run Aug 20, 2026):**
- MCP server attached: **yes** — `dodopayments-mcp` (stdio via npx), Claude Code as client
- Refund tool present: **not as a dedicated tool** — server exposes `search_docs` + `execute` (sandboxed TypeScript against the SDK); refund done via `client.refunds.create()`
- Refund executed + visible in dashboard: **yes** — `ref_0Nlnuh3ezakalh2cWTeaX`, $5.00 partial refund of the $10.99 test payment, status `succeeded`, customer "Ravi Kumar"
- Full refund hit `409 Insufficient funds in wallet` (test-mode fees leave the merchant wallet below the full payment amount) → partial refund within balance worked. **Demo note: seed several test payments first so the wallet can cover full refunds.**
- Roundtrip feel: fast (~1–2 s per execute call)
- Friction found (all solved, keep for build day):
  1. Deno ≥ 2.9 breaks the MCP sandbox — unix-socket serve now needs bare `--allow-net`, server only grants the API host → worker dies with "Deno exited before being ready". Fixed with a one-line `deno` shim at `~/.dodo-mcp-shim/deno` that rewrites the flag.
  2. SDK defaults to **live_mode** → must set `DODO_PAYMENTS_ENVIRONMENT=test_mode` or every call 401s.
  3. Dodo API keys have **no `dodo_test_` prefix** — copy them verbatim.
- **VERDICT: PASS** — an agent moved (test) money through Dodo's MCP end-to-end.

**PASS:** refund created through MCP, visible in dashboard.
**PARTIAL:** MCP flaky but REST API works → build on REST, soften the "open protocol" talking point.
**FAIL:** can't create refunds in test mode at all → see decision gate.

---

## Spike 3 — Freshdesk API sanity (~15 min, low risk)

1. Trial workspace → Profile → API key.
2. One `curl` to create a ticket, one to read it back (their docs have copy-paste examples).

**PASS expected** — mature API. Only checking the trial tier doesn't wall off the API.

---

## Decision gate (already agreed)

| Outcome | Action |
|---|---|
| Spike 1 PASS + Spike 2 PASS | **Build Resolve as designed** — give the go signal, scaffold gets rebuilt |
| Spike 1 partial (Hindi weak) | Resolve, English-first; Hindi as scripted stretch |
| Spike 2 partial (MCP flaky) | Resolve via Dodo REST API |
| BOTH fail AND Agent Studio access is excellent | **Switch to the backup concept** (Skill Forge — ticket-mining agent) |
| Both fail, no Agent Studio access | Regroup — Track 3 shape with different action layer |

## Numbers to carry into the pitch

- Real cost per test call (ElevenLabs credits burned + Anthropic tokens) → recompute the cost-per-call claim with facts.
