# Freshdesk setup — from zero to seeded tickets

Follow this when setting up Resolve's helpdesk on a **new Freshdesk account**
(trials last ~21 days, so this gets repeated). Takes ~15 minutes. Commands run
from the repo root.

## 1. Account — the signup email matters

1. Go to https://www.freshworks.com/freshdesk/ → **Free trial**.
2. ⚠️ Signup **rejects consumer and custom-domain emails**: Gmail fails
   ("business email required") and personal-domain addresses can fail too.
   **A Zoho Mail address works** (last time: `sujeetsingh1216@zohomail.in`).
3. Pick a **subdomain you can live with** — it appears in every demo
   (`<subdomain>.freshdesk.com`) and cannot be changed easily.
4. Note which product you got: **Freshdesk Omni vs classic Freshdesk** — check
   Admin → Plans & Billing that the plan won't expire before demo day.

## 2. API key — two steps, in this order

1. **Enable API access for your agent first**: Admin → **Agents** → Edit your
   agent → allow API access. (Without this the key never appears.)
2. Then: click your avatar → **Profile Settings** → **View API key**.

## 3. `.env`

```
FRESHDESK_DOMAIN=<subdomain>        # just the subdomain, not the full URL
FRESHDESK_API_KEY=...
```

Auth is HTTP Basic with `apikey:X` — handled by `src/integrations/freshdesk.ts`,
plain fetch, no SDK.

## 4. Smoke test (Spike 3)

```
curl -su "$FRESHDESK_API_KEY:X" https://$FRESHDESK_DOMAIN.freshdesk.com/api/v2/tickets | head -c 300
```

Expect HTTP 200 with JSON. A 403 usually means step 2.1 was skipped.

## 5. Seed tickets

```
npm run seed
```

Creates the demo tickets (Ravi's broken-order case, Priya's high-value case)
with order details and a live-looked-up un-refunded Dodo payment id in the
body — so seed **Dodo first** (see DODO-SETUP.md), then Freshdesk.

Per demo run afterwards: `npm run seed:repeat` (fresh Ravi ticket, next ORD-10xx).

## 6. Verify

- Freshdesk dashboard shows the tickets with order details in the body.
- `POST /chat` flow or a voice call finds the customer by email
  (`ravi.test@example.com`) and reads facts from the ticket.

## Gotchas

- **Facts come from the ticket body** — `src/case-context.ts` regex-parses it.
  Don't hand-edit seeded ticket bodies or the parser misses fields.
- Resolutions are written back as **private notes**; escalations set priority
  urgent + a briefing note. If notes fail with 403, re-check API access (2.1).
- Runtime code goes through the `src/helpdesk.ts` seam (`HELPDESK=freshdesk`);
  only the seed scripts talk to Freshdesk-specific endpoints directly.
- OTP emails go to the address on the ticket; `OTP_DEMO_REDIRECT_TO` in `.env`
  redirects `@example.com` mail to a real inbox for demos.
