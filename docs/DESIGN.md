# Resolve — Design Decisions & Runtime Workflow

> Settled BEFORE the build so hour 3 has no surprises. Companion to ../README.md (architecture) and SPIKES.md (validation evidence).

## The call, beat by beat

Beats marked ⏱ happen while the caller waits in silence — the latency budget lives there.

| # | Beat | Hop | Notes |
|---|---|---|---|
| 1 | Call opens | Caller → ElevenLabs widget | Orchestrator pre-warms Freshdesk lookup as soon as the session starts |
| 2 | Verify ⏱ | Tool call → orchestrator → OTP out → caller reads code back → second tool call | `verified` flag lives **server-side, keyed by conversation ID** — never in conversation memory |
| 3 | Context ⏱ | Tool call → orchestrator → Freshdesk (tickets, order, history) | Returned as structured facts |
| 4 | Decide ⏱⏱ | Tool call → Resolution agent (Claude) → Policy-Guard (Claude + hard checks) | **Longest silence in the flow** (two LLM calls, est. 4–10 s — unmeasured). Conversation agent speaks filler by design, not as a patch |
| 5 | Act ⏱ | Guard-approved → Dodo refund (`client.refunds.create`) | Spike-validated: ~1–2 s |
| 6 | Close | Freshdesk note → customer confirmation email → ops view event → confirmed Dodo result returned to conversation agent | Agent confirms **only from the returned transaction state** — the tool response IS the Dodo response, so it cannot confirm early. The ticket note is **private** (agent audit trail); the customer's written confirmation is our own mail (`notify.ts`), best-effort so it can never undo a completed refund |

**Branches (first-class, not error handlers):**
- OTP fails ×2 → polite refusal, ticket annotated, no action path exists.
- Guard denies / low confidence → Escalation agent: structured briefing → prioritized Freshdesk ticket → follow-up scheduled → honest hand-off to caller. (Demo call #2.)
- Chat channel → identical orchestrator endpoints, text pipe. Also the live-demo fallback.

## Decisions (settled Aug 20, 2026)

### 1. OTP delivery — EMAIL now, DLT SMS in production ✅ decided
Hackathon: OTP goes to the customer's registered **email** (real, verifiable), mirrored on the ops view so the audience sees it fire. Agent says "sent to your registered contact."
Production path (documented, not built): SMS via a DLT-registered route (MSG91 / Kaleyra / Twilio India) — India's TRAI DLT regime requires registered sender ID + templates, a days-to-weeks business process. Voice-call OTP is the secondary production option.

### 2. Currency — seed USD, narrate ₹, label transparently
Spike 2 fact: Dodo test-mode checkout rejects INR (`PAYMENT_METHOD_UNSUPPORTED`); US billing + USD works. So demo payments are seeded in USD. The story stays Indian (₹1,499); the ops view shows both honestly: `₹1,499 (test-mode: $18.00)`. No pretending the dashboard says rupees. Re-check INR support once before build day; if it works by then, drop the dual label.

### 3. Idempotency — one action per ticket
The guard records `action_executed` against the ticket before firing Dodo. A repeated `resolve_case` call (ElevenLabs retry, caller asking "did it go through?") returns the **prior confirmed result** instead of re-executing. No double refunds by construction.

### 4. Policy-Guard input contract — structured fields only
The guard receives `{amount, currency, order_id, claim_type, item_type, return_status, customer_history, resolution_confidence}` — **never the conversation transcript**. The conversation agent can be sweet-talked; it just can't approve anything. Conversation and authority are separate processes. This is the prompt-injection defense and it holds only if this contract is never relaxed "just to give the guard more context."

### 5. Dodo integration facts (from SPIKES.md, apply in `integrations/dodo.ts`)
- `DODO_PAYMENTS_ENVIRONMENT=test_mode` is mandatory — SDK defaults to live and 401s.
- API keys have **no** `dodo_test_` prefix — copy verbatim.
- Test-mode fees drain the merchant wallet → **seed several payments** so full refunds clear; partial refunds always work.
- Orchestrator uses the `dodopayments` Node SDK directly (no MCP sandbox, no Deno shim needed — those were spike-client artifacts).
- **Where MCP does belong (Aug 22):** Dodo ships an MCP server and it works — Spike 2 moved real test money through it. It stays out of the *money path* for three reasons: MCP exists so an LLM can choose tools, and the guard's whole premise is that code chooses the refund; it would put an `npx` subprocess (plus the Deno `--allow-net` shim) inside a live call; and it adds latency to the measured 4.8 s beat. It stays in the workflow for what it's genuinely good at — validating the API without writing code, and **read-only lookups** ("status of payment X", "list this customer's refunds") while a human works an escalated ticket. Talk-track: *"the guard's refund goes through the SDK; our humans look up through the MCP."*

### 6. One UI (React), two package managers
The plain-HTML pages were retired on Aug 22 — React in `web/` is the only UI, served as a static build at `/app`, and `/` redirects there. Keeping two UIs meant every change had to be made twice, so the HTML copy was deleted outright on Aug 22 — React is the only path now.
Root runs **npm** (tsx/express), `web/` runs **yarn 4** — the UI is a self-contained Vite app and yarn is what it was scaffolded against, so the split is left alone rather than churned mid-hackathon. Root `*:web` scripts wrap yarn so the split never surfaces during a demo. Two non-obvious details, both load-bearing: `web/.yarnrc.yml` pins `nodeLinker: node-modules` because Yarn 4 defaults to Plug'n'Play and Vite/tsc don't expect it, and `web/yarn.lock` was created **empty on purpose** — that's how Yarn 4 marks `web/` as its own project instead of demanding it be a workspace of the root. Without it, install fails with "doesn't seem to be part of the project declared in …".

### 7. Provider seams — the vendors are defaults, not dependencies (Aug 22)
`brain.ts` already proved the pattern (mock → Gemini → Groq, swapped three times with zero agent changes), so the same seam now exists for the other two vendors: **`src/payments.ts`** (`PaymentProvider`, `PAYMENTS=dodo`) and **`src/helpdesk.ts`** (`Helpdesk`, `HELPDESK=freshdesk`). The agents, guard, and escalation import the interface, never a vendor SDK — `resolve-case.ts`, `case-context.ts`, and `escalation.ts` are now vendor-free. Adding Stripe/Razorpay or Zendesk/Intercom = one module satisfying the interface + one line in the factory.
Pure extraction: no behaviour change, one implementation each, same defaults. Deliberate boundaries — (a) **`seed.ts` / `seed-repeat.ts` keep using the Dodo/Freshdesk SDKs directly**, because seeding demo products and checkout links is inherently vendor-specific and abstracting it buys nothing; (b) **`createTicket` is not in the `Helpdesk` interface** for the same reason — only seeds create tickets; (c) **`case-context.ts` still regex-parses order facts out of the ticket body**, so a new helpdesk needs its own body format or parser — the seam moves the API calls, not the content contract; (d) ops-view event names (`freshdesk.note_added`) still name the real provider in use, which is honest and keeps the audit-log vocabulary stable.
Voice is already the least coupled of the three: ElevenLabs only reaches us through token-authenticated `/tools/*` webhooks, so nothing vendor-specific lives in `src/` except `setup-voice.ts` (provisioning). Any vendor that can POST a webhook works.
**Pitch note:** these are the hackathon's sponsors — frame this as "drops into an existing stack without rewriting the agents, and goes deeper with Freshworks, not around it," never as "we can replace you."

### 8. Physical goods — the return gate (Aug 22)
The obvious hole in "AI refunds autonomously": you don't get the money back before the product comes back. So `CaseFacts` now carries `item_type`, `return_status`, `delivered_at` and `return_window_days`, and the guard has a fourth hard check — `awaiting_return`: a **refund** on a **returnable** item whose return isn't `completed` cannot be auto-approved. Code, not model: a parcel either arrived or it didn't.
Six decisions inside that:
- **It's a "not yet", not a "no".** `resolve-case.ts` routes this one denial to `returns.ts` instead of to escalation — the agent arranges the return pickup itself and tells the customer the refund releases automatically when the parcel lands. Every other denial still goes to a human. A refusal that hands back a next step is worth more than one that hands back a queue position.
- **Keyed by order id, and no new ticket.** One RMA per order, file-backed in `data/returns.json`, so a repeat call, a re-run on the same ticket, or a second ticket about the same order all find the existing RMA rather than sending a second courier. The refund ticket itself is parked at status *pending* with the RMA on it — real RMA flows don't fork the case, and `createTicket` deliberately isn't in the `Helpdesk` seam (decision 7b).
- **The customer cannot mark their own parcel returned.** `return_status` comes from the RMA store or the ticket body, never from what's said; `/tools/return-received` (the WMS hook in production) sits behind the same shared secret as the voice tools. Same shape as the OTP verified flag.
- **Read live, not from the snapshot.** `CaseFacts` are captured at context lookup, but the parcel can arrive between lookup and decision, so `withLiveReturnStatus` re-reads the store inside `resolveCase`. Without this the held refund could never be released in the same session.
- **Physical is not the same as returnable.** My first cut of this gate treated the two as synonyms, which was wrong: perishables, opened hygiene items, custom-made pieces and final-sale goods are physical but nothing ever comes back. Under that version the refund was held forever on a parcel that could never arrive — and the agent would have offered to send a courier for melted ice cream. So `not_required` is the "skip the gate" status and covers **both** digital goods and non-returnable physical ones, and the guard keys off a named `returnOwed()` predicate rather than `item_type` alone. The parser had the matching bug: `Return: not applicable (perishable)` was read as `not_started` ("a return is owed, not yet raised") because the negation regex matched "not". *Not applicable* and *not requested* are opposite meanings, so they're now separated, with an explicit `Returnable: No` line available in the ticket body to state product policy outright. Deliberate limit: a non-returnable item skips the window too — a tighter claim window for perishables ("report within 48 hours") is a different policy and isn't built.
- **The return window lives inside the gate, and it's a "no".** Before arranging anything, the guard checks `delivered_at` against `return_window_days` (per-product) or `RETURN_WINDOW_DAYS` (store-wide, default 14) and denies with `return_window_expired` — because there is no point dispatching a courier for an item that is out of policy. That denial goes to a **human**, not to `returns.ts`: "you're outside the window" is a policy no, and only a person can grant an exception. Two deliberate asymmetries: the window is **skipped once `return_status` is `completed`** (if the warehouse accepted the parcel, that acceptance *was* the policy decision — the agent doesn't get to re-litigate it), and a missing `delivered_at` **does not** enforce a window, because a gap in our own data must never become a denial to a customer. Ordering: expired is checked before unreturned, so an out-of-policy claim never gets a pickup it can't cash in.
Hard-check order is therefore `unverified` → `auto_limit` → `no_payment` → `return_window_expired` → `awaiting_return`. The return checks are appended **last** on purpose: an unverified or over-limit caller is turned away before the system will so much as book a courier for them, and no existing demo outcome changed when the gate landed. `AUTO_LIMIT` still applies *after* the gate opens, which is the honest ordering: returning the item earns you the automatic refund only up to ₹5,000 — above that a human still decides. Digital goods (`not_required`) skip the gate entirely, which is why the subscription scenario is unchanged. Where `item_type` isn't stated in the body it's inferred from the item name, so tickets seeded before this existed still classify correctly.
**Talk-track:** *"the guard automates the refund where the amount is a fact, not an opinion — and the moment a human has to look at a physical object, it escalates."*

## Known-unmeasured (time during build, before rehearsal)
1. Beat 4 end-to-end latency (two Claude calls) — the flow's biggest unknown.
2. ElevenLabs webhook → our tunnel (ngrok or similar) → orchestrator roundtrip; rehearse on the hotspot.
3. Freshdesk API (Spike 3, pending trial — low risk).
