# Resolve — Coding Rules

## Workflow

- **Never run `git commit` or push.** Make and stage changes; the user commits.
- Stay inside the locked demo scope ([PRD.md](PRD.md)) unless asked to expand it.
- Verify before claiming. A 200 from a smoke test isn't proof — confirm on a real routed call through the Ops event feed.
- Don't assert how a vendor UI (Freshdesk, ElevenLabs, Shopify) works from general knowledge. Ask the user to check and report back.
- Run `npm run typecheck` and `npm test` after code changes.

## Code style

- Match the surrounding code: naming, structure, idiom.
- Keep comments short and only for the non-obvious: a gotcha, a why-not, a link to a source of truth. Never restate what the code does.
- No unrequested extras: no speculative abstractions, no narration comments, no debug leftovers.

## Safety invariants — never relax these

- The policy guard receives structured facts only, never the transcript or caller text.
- `verified` and `return_status` live server-side; nothing the caller says can set them.
- Amounts and payment IDs come from the ticket/order system, never from the conversation.
- Hard checks are code, not model judgment.
- Idempotency is recorded before a refund fires.
- A gap in our own data must never become a denial to the customer.
- Agents import the provider interfaces (`payments.ts`, `helpdesk.ts`, `oms.ts`), never a vendor SDK directly. Seeds are the exception.

## Secrets

- Secrets live only in `.env` (gitignored). Never write a key, token, or real customer email into code, docs, or commit messages.
- The audit trail holds customer data — keep it CLI-only, never an HTTP route.

## Repo layout

- Root uses npm; `web/` uses yarn 4. Use the root `*:web` scripts.
- Docs go in `docs/` with uppercase filenames: core docs at the top level, vendor guides in `setup/`, demo material in `demo/`, finished or superseded docs in `archive/`.
