# Resolve — Tasks & Progress

> Last known state: 2026-09-30 (post-demo).
> ⬜ todo · 🔄 in progress · ✅ done · ❓ unknown

## Outcome

**Demo day (2026-09-26): WON "Best Use of Vobiz"** 🏅 at The Great Agent Hackathon (TGPF 2026, Bangalore) — ₹10,000 cash + ₹50,000 Vobiz credits. Live refunds executed on stage. The build continues post-hackathon.

## Done

- ✅ Core loop: OTP → context → resolution → guard → Dodo refund → Freshdesk note → email confirmation
- ✅ Escalation with briefing and follow-up; return hold with RMA
- ✅ Brain fallback chain `auto-claude` (Claude → Sarvam → Groq)
- ✅ Shopify order source (read-only) verified live
- ✅ Freshdesk AI Agent Studio wired to the 4 `/tools/*` actions, verified end to end
- ✅ ElevenLabs native voice agent pointed at the production domain
- ✅ Freshdesk relay voice path built and verified over HTTP
- ✅ Diagnostic events on every early-return path in `/tools/*`
- ✅ All 4 demo flows rehearsed on local data
- ✅ All 4 demo flows run on Shopify data — dry-run verified 2026-09-25, live on stage 2026-09-26
- ✅ USD limit mismatch resolved — `.env.example` now says 50000 ($500), matching `config/policy.json` (2026-09-30)
- ✅ Hackathon submission complete — event concluded 2026-09-26

## Open

| | Task | Notes |
|---|---|---|
| ❓ | Live-test the relay's reworded stall lines by voice | New wording is committed; no record of a live test yet |
| ⬜ | Fix relay bug: bot claims the OTP was sent when no tool ran | Only when the order ID isn't given up front. Zero backend events for that ticket. Next: have the user open the workflow's "Execute API action" nodes and report their settings |
| ⬜ | Verify the relay agent on a real ElevenLabs voice call | Only tested via direct HTTP so far |

## Deferred (after the demo)

- Shopify `write_orders` scope
- Live ticket creation for the "manual review" voice use case
- Freshcaller integration (waiting on mentors)
- Multiple concurrent calls on the relay
