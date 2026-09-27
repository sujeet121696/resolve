# Resolve — Tasks & Progress

> Last known state: 2026-09-24 (pre-demo). The demo was 2026-09-26 — update this with the outcome.
> ⬜ todo · 🔄 in progress · ✅ done · ❓ unknown

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

## Open

| | Task | Notes |
|---|---|---|
| ❓ | Run the 4 demo flows on Shopify data | Needs one large order for the escalate flow |
| ❓ | Live-test the relay's reworded stall lines by voice | New wording is committed; no record of a live test yet |
| ⬜ | Fix relay bug: bot claims the OTP was sent when no tool ran | Only when the order ID isn't given up front. Zero backend events for that ticket. Next: have the user open the workflow's "Execute API action" nodes and report their settings |
| ⬜ | Verify the relay agent on a real ElevenLabs voice call | Only tested via direct HTTP so far |
| ⬜ | Resolve the USD limit mismatch | `.env.example` says 5000 ($50), `config/policy.json` says 50000 ($500) |
| ⬜ | Stage 2 submission: deck link, demo video link | Local-only draft: `docs/DEVPOST-SUBMISSION.md` |

## Deferred (after the demo)

- Shopify `write_orders` scope
- Live ticket creation for the "manual review" voice use case
- Freshcaller integration (waiting on mentors)
- Multiple concurrent calls on the relay
