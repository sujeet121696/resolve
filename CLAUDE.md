# Resolve — context for AI coding tools

Voice-first support agent that executes resolutions (refunds, return holds, escalations) live on the call, under a policy guard.

## Read first

| File | What it holds |
|---|---|
| [docs/PRD.md](docs/PRD.md) | What we're building, for whom, and what's out of scope |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Channels, request flow, modules, provider seams |
| [docs/RULES.md](docs/RULES.md) | Coding and workflow rules — follow these |
| [docs/DESIGN.md](docs/DESIGN.md) | Settled design decisions and why |
| [docs/TASKS.md](docs/TASKS.md) | Current status, open bugs, next steps |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | Setup, running, and demo operations |

Also in `docs/`: `setup/` (per-vendor setup), `demo/` (demo scripts), `archive/` (historical — not current status), `COST-ANALYSIS.md`.

## Layout

```
src/       backend (Express + TypeScript, npm)
web/       React UI (Vite, yarn 4) — served from web/dist at /app
fdk-app/   Freshdesk marketplace app
config/    policy.json, pricing.json, cloudflared.yml
data/      runtime state (gitignored)
backup/    private material (gitignored) — never publish
```

## Commands

```
npm run dev          # backend, watch mode
npm run dev:web      # React UI
npm run build:web    # rebuild web/dist after UI changes
npm run typecheck
npm test
npm run setup:voice  # re-run after any PUBLIC_BASE_URL / TOOLS_TOKEN / agent change
npm run audit        # read the audit trail
```

## Non-negotiables

- Never commit — the user commits manually.
- The policy guard never sees the conversation transcript.
- Keep comments short and only where the code isn't self-explanatory.
