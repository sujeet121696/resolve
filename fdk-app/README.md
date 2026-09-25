# Resolve — Freshdesk sidebar app (FDK custom app)

A `ticket_sidebar` panel for the human agent: open any ticket and see what
Resolve did on it — order + amount, the guard's approved/denied record with
hard-check names, RMA state, the idempotency record, and the related audit
events. One action: **mark return received** (the warehouse scan the demo
script otherwise fires via curl), two-click armed.

Data comes from `GET /tools/case-brief` (read-only, added in `src/server.ts` /
`src/case-brief.ts`) through the Freshworks request proxy — the tools token is
a **secure iparam**, substituted server-side, never visible in the browser.

## Run locally (renders inside the real Freshdesk UI — no publishing needed)

Node 18 is required by the FDK CLI (Volta pin in package.json handles it):

```bash
cd fdk-app
npm install            # installs the official FDK from cdn.freshdev.io
npx fdk run            # starts the local dev server on :10001
```

Then:
1. Enter iparams at http://localhost:10001/custom_configs — paste the
   `TOOLS_TOKEN` value from the repo's `.env` as **Resolve tools token**.
2. Open any ticket in the Freshdesk portal with `?dev=true` appended to the
   URL (e.g. `https://<domain>.freshdesk.com/a/tickets/83?dev=true`) — the
   Resolve panel appears in the right sidebar's Apps section. No cert step:
   the dev server is plain HTTP and browsers trust localhost.

## Publish to the portal (optional)

```bash
npx fdk validate
npx fdk pack -s        # → dist/fdk-app.zip  (-s skips the 80% coverage gate,
                       #    which only applies to marketplace submissions)
```

Freshdesk Admin → Apps → Custom Apps → **Publish Custom App** → upload the
zip → enter the tools token when asked.

## Demo notes

- The demo does NOT depend on this app — it's a bonus panel. If it misbehaves,
  just don't open it; the voice flow is untouched.
- The "mark return received" button on ravi's ticket replaces the warehouse
  curl in scenario 1+2 — click it between call 1 and call 2.
