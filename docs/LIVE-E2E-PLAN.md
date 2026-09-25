# Live end-to-end plan — Studio + Freshdesk + Shopify + Dodo

Goal: the Stage 2 demo runs **fully live** — no `OMS=local` data on screen.

```
Customer (Freshdesk AI Agent Studio chat  |  ElevenLabs voice)
      │
      ▼
Freshdesk ticket ─── subject carries the order number (ORD-####)
      │
      ▼
Resolve backend (tunnel)
  ├─ get-context : ticket → order number → Shopify order   (OMS=shopify, read-only)
  ├─ OTP         : emailed code, verified server-side
  ├─ policy guard: verified · ₹5,000 limit · 14-day window · return gate
  └─ refund      : Dodo test-mode refund
      │
      ▼
Freshdesk note on the ticket (+ handoff to "refund" group when denied)
```

The guard, not the agent, decides. Studio only relays.

## What is already true (verified)
- Studio agent → backend → OTP → guard → handoff works end to end (audit trail, conv 15).
- Verified path continues to `resolve-case`; unverified/expired stops.
- Shopify adapter exists and was verified live (Aug 23) with order #1001.
- Studio "Shopify for AI Agents" is connected to `resolve-demo` (reinstalled Sept 21).

## Phases

| # | Work | Owner | Status |
|---|---|---|---|
| 1 | Shopify adapter: return window starts at order date when unfulfilled (`shopify.ts`, 6 new tests) | Claude | done |
| 2 | Inventory `resolve-demo`: order #, date, email, Note (`dodo_payment_id`) | You | needed |
| 3 | Create demo orders + free Dodo payments (see scenarios) | You + Claude | open |
| 4 | Freshdesk tickets that reference those order numbers | Claude (seed) | open |
| 5 | `.env`: `OMS=shopify`; restart; curl-check each scenario | Claude | open |
| 6 | Studio: activate new flow, remove old `Resolve` + `rwfund` from the agent (keep in library), extra handoffs | You approve, Claude does | open |
| 7 | Agent-level tests (Preview AI Agent) for every scenario | Claude + you (OTP) | open |
| 8 | Deploy channel, voice check, rehearse, record | You | open |
| 9 | Update docs (RUNBOOK, DEMO-SCENARIOS), memory, commit | Claude / you commit | open |

## Scenarios the live demo must cover

| # | Scenario | Order in Shopify | Expected |
|---|---|---|---|
| S1 | Small physical, return not yet received | physical ≤ ₹5,000, recent | return arranged, **no money moves** |
| S2 | Same, parcel scanned in | same order | Dodo refund, ticket note |
| S3 | Over the limit | digital/physical > ₹5,000 | guard denies → handoff to `refund` |
| S4 | Past 14 days | physical, order date > 14 days ago | `return_window_expired` → handoff |
| S5 | Wrong / expired code | any | message shown, flow stops, no `resolve-case` |
| S6 | Attack: fake amount / skip OTP | any | refused |

The 14-day rule only applies to **physical, returnable** items; a digital plan never
hits it.

## Open questions
1. **Old order for S4.** A dev store cannot backdate orders from the admin. Options:
   an existing older order in `resolve-demo`; widen our app to create a backdated order
   via the Admin API; or lower `RETURN_WINDOW_DAYS` for the demo (weakest).
2. **Emails.** The customer email comes from the Freshdesk requester, not Shopify
   (protected customer data, not requested). Tickets must use the emails we demo with.
3. **Shopify refund record.** We do not use Shopify *Refund Order* — that would be a
   second money path. Optional later: a Shopify note/close after the Dodo refund.

## Fallbacks
- If Shopify is unreachable, `getOrderSource()` falls back to local and the case
  degrades to a human via `no_payment`, never a wrong refund.
- Keep the seeded local scenarios working for rehearsal and recording.

## Rules
- Old Studio workflows are removed from the agent only after S1–S6 pass; they stay in
  the Workflows library. Nothing is deleted.
- No commits or pushes without an explicit go-ahead.
