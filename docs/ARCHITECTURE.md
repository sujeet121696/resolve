# Resolve — Architecture

For *why* things are shaped this way, see [DESIGN.md](DESIGN.md).

## Stack

- Backend: Node.js + TypeScript + Express (`src/server.ts`), npm
- UI: React + Vite in `web/`, yarn 4, served as a static build at `/app`
- Freshdesk marketplace app: `fdk-app/`

## Channels

Every channel reaches the same token-authenticated tool endpoints (`x-resolve-token` = `TOOLS_TOKEN`):

```
Chat   → Freshdesk AI Agent Studio widget ─┐
Voice  → ElevenLabs agent (web widget)   ──┼──► /tools/get-context
Phone  → Vobiz SIP → same ElevenLabs agent ┘    /tools/send-otp
                                                /tools/verify-otp
                                                /tools/resolve-case
```

- Freshdesk AI Agent Studio has no phone deploy option, so voice runs on ElevenLabs with its own tool-calling.
- An alternative voice path, `/voice/freshdesk-relay`, uses ElevenLabs only for speech and relays each turn to the Freshdesk AI Agent (`src/voice-freshdesk-relay.ts`). It supports one call at a time.
- `/chat` is a built-in fallback if the Freshdesk widget fails.

## Request flow

```
get-context → OTP send/verify → resolve-case
                                   │
             resolution agent (LLM proposes)
                                   │
             policy guard (hard checks, then LLM judge — structured facts only)
                                   │
        ┌──────────────┬───────────┴────────────┐
     approve        awaiting_return          any other deny
  Dodo refund     returns.ts (RMA, hold)    escalation agent
  ticket note                               (briefing + follow-up)
  email confirm
```

## Modules (`src/`)

| Area | Files |
|---|---|
| Orchestration | `server.ts`, `resolve-case.ts`, `case-context.ts`, `case-brief.ts` |
| Agents | `agents/resolution.ts`, `agents/policy-guard.ts`, `agents/escalation.ts` |
| Brain seam | `brain.ts` → `brain/claude.ts`, `sarvam.ts`, `groq.ts`, `gemini.ts`, `mock.ts` |
| Provider seams | `payments.ts` (Dodo), `helpdesk.ts` (Freshdesk), `oms.ts` (Shopify / local) |
| Integrations | `integrations/dodo.ts`, `freshdesk.ts`, `freshdesk-webchat.ts`, `shopify.ts`, `order-store.ts` |
| Identity | `otp.ts`, `mailer.ts`, `notify.ts` |
| Policy | `policy-config.ts` ← `config/policy.json` (env overrides win) |
| Returns | `returns.ts` (RMA store, `data/returns.json`) |
| Observability | `events.ts` (live Ops feed via `/events`), `audit.ts` (`data/audit.jsonl`), `metrics.ts` |
| Admin | `admin.ts` (live policy editing) |
| Setup | `setup-voice.ts`, `setup-voice-freshdesk-relay.ts`, `seed*.ts` |

## Brain

`BRAIN` env picks the provider. Production default is `auto-claude`: Claude → Sarvam → Groq, falling back on error or rate limit.

## Configuration

All config comes from `.env` (template: `.env.example`) plus `config/policy.json`. `PUBLIC_BASE_URL` is baked into the ElevenLabs tool URLs — re-run `npm run setup:voice` whenever it changes.
