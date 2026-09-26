# Resolve 🎙️💸

**A voice-first customer support agent that closes tickets with money, not words.**

Resolve answers a customer's phone call, understands their problem in Hindi or English, verifies who they are, pulls their full context from Freshdesk, decides the right resolution under policy — and then *executes* it: issuing the refund through Dodo Payments, live, mid-call. The ticket updates itself. The customer gets voice + email confirmation. Total time: under 90 seconds for what today takes days of email ping-pong.

The brain is **channel-agnostic**: the same agents serve voice and chat — voice is the demo, the action layer is the product.

> Built for **The Great Agent Hackathon** @ The Great Product Festival 2026, Bangalore — **Track 1: Customer Experience & Employee Onboarding**.
> Powered by Freshworks (title sponsor) · ElevenLabs (build partner) · Dodo Payments (credit partner).

---

## What it is

A multi-agent, voice-first support system. A conversational voice agent (ElevenLabs) on a real Indian phone number (Vobiz) front-ends a policy-guarded action layer: the caller is OTP-verified, their case is pulled from Freshdesk, an AI resolution brain decides under merchant policy, an independent Policy-Guard approves or vetoes, and the approved refund executes through Dodo Payments — live, mid-call. The same brain also serves chat.

## What it does (business objective)

- **Closes the last mile of support**: executes the resolution (refund, return, escalation) instead of describing it — the ticket updates itself, the customer gets voice + email confirmation.
- **Collapses resolution time from days to under 90 seconds**, and cost-per-resolution from a human-touched ticket to API pennies.
- **Executes the merchant's existing policy at machine speed** — auto-approve limits, return gates, per-customer velocity caps and a daily payout ceiling, all merchant-configurable live from a console, with every decision on an auditable trail.
- **Knows what it doesn't know**: low-confidence or over-limit cases escalate to a human with a structured call briefing, and the agent schedules its own follow-up.

## What it doesn't do (out of scope)

- No plan-change executor yet (typed, guard-checked, but returns `unsupported` rather than pretending), no replacement/exchange flows, and no real courier booking — a token-guarded webhook stands in for the warehouse scan.
- No WhatsApp channel, multi-tenant auth, or analytics dashboards — architecture extends to them; the hackathon hours went to making the money loop flawless.
- Never moves money without OTP identity, order ownership, policy, and Policy-Guard approval — by design there is no override path from the conversation.

## Product Integrations

| Product | Used for |
|---|---|
| **Freshworks (Freshdesk)** | System of record: caller's tickets looked up by OTP-verified email; resolutions written back as private audit notes; status/priority updates; escalations filed as prioritized tickets with a structured human briefing; Freshdesk chat widget in the web demo |
| **Sarvam AI** | Resolution brain (`sarvam-105b-conversations`): proposes the action and independently re-judges it, confidence-scored (`BRAIN=sarvam`) |
| **Anthropic (Claude)** | Alternative resolution brain behind the same seam (`BRAIN=claude`); the project itself was built with Claude Code |
| **ElevenLabs** | Conversational voice agent — STT, TTS, turn-taking, Hindi/English |
| **Vobiz** | Real Indian phone number (DID) routed over a SIP trunk into the ElevenLabs agent — TRAI-compliant inbound telephony |
| **Dodo Payments** | Refund execution via SDK (real transactions, test mode); payment path validated with Dodo's MCP server |
| **Shopify** | Order system: order facts and email→order ownership verification (deliberately read-only scope) |
| **Groq / Gemini** | Additional interchangeable brains behind the same interface — the brain is a config choice, not an architecture |

## System Interaction Diagram

See [Architecture](#architecture) below — caller/chat → ElevenLabs agent → orchestrator (verify → Freshdesk context → resolution brain → Policy-Guard → Dodo execution → Freshdesk close), with the ops view and audit trail observing every step.

---

## The Problem

Support "resolution" today ends where the real resolution begins. AI chatbots deflect and summarize — but when the fix requires **money to move** (a refund, a plan downgrade, a replacement order), the customer gets a ticket number and a multi-day wait while a human copies data between the helpdesk, the payment system, and the order system.

- A refund crosses systems (helpdesk, payments, orders) that only a human with access to all of them is allowed to connect — so the request waits in a queue.
- Customers don't churn because the answer was wrong — they churn because the *action* was slow.
- Existing "AI agents" bolt an LLM onto FAQ search. The last mile — the transaction — stays manual.

## The Solution

Resolve is an **agentic loop that owns the last mile**:

1. **Perceive** — Answers a real phone call (ElevenLabs Agents: STT + TTS + turn-taking, Hindi/English) or a chat message — same brain, any channel. Pulls the caller's tickets, orders, and history from **Freshdesk**.
2. **Verify** — Before anything moves, the caller proves who they are: an OTP goes to the registered number/email and is read back mid-conversation. No identity, no action.
3. **Decide** — A resolution brain matches the case against refund policy. Every proposed action must be approved by an independent **Policy-Guard agent** (amount limits, fraud signals, confidence threshold, and — for physical goods — whether the item has actually been returned). The guard never talks to the customer — it can't be sweet-talked, social-engineered, or prompt-injected through the conversation.
4. **Act** — Executes the approved resolution through the **Dodo Payments SDK**: the refund is issued — a real transaction, not a promise. (Dodo's MCP server is how we validated the payment path during spikes; execution calls the SDK directly so the guard-approved money call stays deterministic and out of the model's reach.)
5. **Close** — Writes the resolution back to Freshdesk as a private audit note, confirms by voice, and emails the customer the confirmed refund reference (SMS via DLT-registered route is the production path).
6. **Escalate when unsure** — Low-confidence or over-limit cases are handed to a human *with a full call briefing* attached to a prioritized ticket, and the agent schedules its own follow-up. The agent knows what it doesn't know.

### Why multi-agent (and not one LLM in a loop)

| Agent | Job | Why it's separate |
|---|---|---|
| **Conversation agent** (ElevenLabs) | Listens, speaks, drives dialogue | Optimized for latency & naturalness, not judgment |
| **Resolution agent** | Diagnoses the case, proposes an action plan | Reasons over full ticket/order context |
| **Policy-Guard agent** | Approves/denies every money-moving action | An agent must never audit itself — separation of powers |
| **Escalation agent** | Packages context for humans, tracks follow-ups | Owns the failure path so failures are graceful |

## Demo

📹 **Video walkthrough:** https://youtu.be/SwnDqiQuOmo

**Call #1 — the happy path:** Sujeet's order arrived broken. They call, speak Hindi. Resolve identifies them, verifies the issue against their order, issues a ₹1,499 refund through Dodo live on screen, updates the Freshdesk ticket, and confirms — in 90 seconds.

**Call #2 — the agent that knows its limits:** An ambiguous, high-value claim. Resolve detects low confidence, declines to act autonomously, escalates to a human with a structured briefing, and books its own follow-up call. *This is the difference between an agent and a script.*

## Architecture

```
 Caller ── phone / web widget ──────▶ ┌──────────────────────────────┐
                                      │  ElevenLabs Agent            │
                                      │  STT · LLM · TTS · turns    │
                                      │  Hindi / English             │
 Chat ──── web / Freshchat ──┐        └──────────┬───────────────────┘
                             │                   │ tool calls (webhooks)
                             ▼                   ▼
                                      ┌──────────────────────────────┐
                                      │  Orchestrator (our server)   │
                                      │  OTP identity verification 🔐│
                                      │  Resolution agent            │
                                      │  Policy-Guard agent ✋       │
                                      └───┬─────────┬───────────┬────┘
                                          │         │           │
                              ┌───────────▼──┐ ┌────▼───────┐ ┌─▼──────────────┐
                              │  Freshdesk   │ │ Dodo       │ │ Escalation      │
                              │  tickets,    │ │ Payments   │ │ human handoff + │
                              │  customer &  │ │ Node SDK   │ │ call briefing   │
                              │  order data  │ │ (refunds)  │ │ (Freshdesk)     │
                              └──────────────┘ └────────────┘ └────────────────┘
```

## Tech Stack

| Layer | Technology |
|---|---|
| Voice & conversation | [ElevenLabs Agents](https://elevenlabs.io/docs/agents-platform/overview) — telephony, STT/TTS, tool calling |
| Helpdesk / system of record | [Freshdesk](https://developers.freshworks.com/) REST API |
| Payments execution | [Dodo Payments](https://dodopayments.com/) — Node SDK, test mode (their MCP server validated the path during spikes and is used for read-only lookups) |
| Orchestrator | Node.js (TypeScript) · Express webhooks |
| Agent reasoning | Pluggable brain (resolution + policy-guard agents) — Claude (Anthropic API, production default since Sept 2026) with Sarvam then Groq as fallback |
| Ops view (demo screen) | Lightweight web dashboard — live ticket + transaction feed |

## Getting Started

> 📖 **Full step-by-step manual: [docs/RUNBOOK.md](docs/RUNBOOK.md)** — one-time setup,
> starting the stack, seeding demo data, running the demo call, troubleshooting.

The short version:

```bash
git clone <this-repo>
cd resolve
npm install
npm run install:web && npm run build:web        # the React UI (yarn-managed) at /app
cp .env.example .env    # fill in the keys — .env.example documents each one
npm run dev             # orchestrator on :3000 — UI at /app (ops view: /app/ops)
ngrok http 3000         # public tunnel for the voice agent's webhooks
                        # (or `cloudflared tunnel run` if you have a domain on
                        # Cloudflare — same idea, but the URL stays fixed
                        # across restarts instead of changing every time)
npm run seed            # demo customers, payments, and Freshdesk tickets
npm run setup:voice     # configures the ElevenLabs agent + its 4 tools
```

Needs Node.js ≥ 20 and free-tier accounts for ElevenLabs, Freshdesk,
Dodo Payments (test mode), Groq, and a tunnel (ngrok, or Cloudflare Tunnel if
you own a domain on Cloudflare) — details in the runbook.

## Project Structure

```
resolve/
├── src/
│   ├── server.ts          # orchestrator — voice webhooks, chat, OTP, SSE events
│   ├── brain.ts           # pluggable brain seam (mock / groq / gemini / auto)
│   ├── brain/             # per-provider brains
│   ├── agents/
│   │   ├── resolution.ts  # diagnoses case, proposes action
│   │   ├── policy-guard.ts# approves/denies money-moving actions
│   │   └── escalation.ts  # human handoff: briefing note + follow-up
│   ├── resolve-case.ts    # propose → policy-guard → refund → ticket note
│   ├── returns.ts         # RMA store: physical goods come back before money goes out
│   ├── otp.ts             # identity verification (send / verify / lockout)
│   ├── chat.ts            # chat channel state machine (same brain)
│   ├── integrations/
│   │   ├── freshdesk.ts
│   │   └── dodo.ts
│   ├── seed.ts            # demo world: products, customers, tickets, payments
│   └── setup-voice.ts     # scripts the ElevenLabs agent + its 4 tools
├── web/                   # React UI (Vite) — home, chat, live ops view → /app
├── docs/                  # RUNBOOK · BUILD-PLAN · DESIGN · SPIKES
└── README.md
```

## Scope (hackathon fence)

**In:** voice loop via web widget, telephony as stretch (Hindi + English) · **chat channel (same brain, text pipe)** · **OTP identity verification** · **refund execution (full and partial)** · **the return gate — physical goods come back before money goes out** · policy-guarded autonomy (incl. conversation-isolation from prompt injection) · human escalation with briefing · live ops view.

**Half-built, honestly:** `plan_change` is a first-class action in the type system, the brains know it, and the Policy-Guard already limit-checks it — but there is no executor yet, so an approved plan change returns `unsupported` rather than pretending. The return gate is real where it matters and stubbed where it doesn't: the guard genuinely blocks the refund, the RMA is durable and de-duplicated per order, and the ticket is parked pending — but **no courier is actually booked**, and "the parcel arrived" is a token-guarded webhook standing in for a WMS. Replacement/exchange flows are absent for the same reason: there is no fulfilment system behind them, and a demo of a dispatch that never happens is theatre.

**Deliberately out (extension story, not code):** WhatsApp, multi-tenant auth, more languages, more resolution types, analytics. The architecture extends to all of them — the 24 hours go to making two flows flawless.

## Team

| Name | Role | Relevant experience |
|---|---|---|
| Sujeet | End-to-end build — voice loop, agents, integrations | Software engineer — production LLM APIs at scale (classification and prediction over messy real-world data), document processing and inventory systems |

## Roadmap (beyond the hackathon)

- **Freshworks Agent Studio:** move the Resolution agent into Agent Studio as its native home (pending participant sandbox access)
- **Plan changes:** finish the `plan_change` executor on Dodo subscriptions — `previewChangePlan` returns the exact prorated charge, so the guard approves that number rather than a vague intent
- **More last-mile actions:** exchanges, address changes, subscription pauses
- **Language expansion:** Tamil, Telugu, Kannada, Bengali via ElevenLabs multilingual voices
- **Freshworks Marketplace app:** one-click install for any Freshdesk workspace
- **Policy-as-config:** shipped first: `config/policy.json` + live-editable velocity caps (per-customer daily caps, daily payout ceiling) from the Merchant console — next, autonomy limits in plain language

## Final submission (Stage 2)

| Field | Value |
|---|---|
| Team Name | Resolve *(exactly as registered on Devpost — `devpost.com/software/resolve-k72r3w`)* |
| Selected Track | Track 1: Customer Experience & Employee Onboarding |
| GitHub Repository | https://github.com/sujeet121696/resolve |
| PPT / Presentation | *TODO — upload deck, paste share link (test in incognito)* |
| Demo Video URL | *TODO — record & upload Stage 2 video, paste link* |
| Deployment / Live URL | https://resolve.kharidwise.com |

**2–3 line description:**
Resolve is a voice-first support agent that closes tickets with money, not words. A customer calls, is OTP-verified, and Resolve pulls their case from Freshdesk, checks it against merchant policy, and executes the refund live through Dodo Payments mid-call — with an independent Policy-Guard agent that must approve every money-moving action. Under-90-second resolutions for what today takes days of email ping-pong; unsure cases escalate to a human with a full briefing.

**How Freshworks is integrated:**
Freshdesk is Resolve's system of record. The agent looks up the caller's open tickets by their OTP-verified email, reads the case from the ticket, and — after acting — writes the resolution back as a private audit note, updates ticket status/priority, and files escalations as prioritized tickets with a structured human briefing. The web demo also embeds the Freshdesk chat widget, so the same brain serves voice and Freshdesk chat.

**Sarvam usage:**
Sarvam's hosted `sarvam-105b-conversations` model powers the resolution brain — it proposes the action for each case and independently re-judges it (confidence-scored, JSON mode) behind the same interface as our other brains, selectable via `BRAIN=sarvam`. The policy guard's hard checks remain deterministic code, so Sarvam does the judgment, never the money call itself.

**Vobiz usage:**
Vobiz provides Resolve's real Indian phone number (+91 80642 66330): a paid DID routed over a Vobiz SIP trunk (`resolve-inbound`) into the ElevenLabs conversational agent — the TRAI-compliant way to give an Indian caller a local number, where Twilio blocks trial number import. Callers dial a normal local number and reach the agent directly.

## License

MIT
