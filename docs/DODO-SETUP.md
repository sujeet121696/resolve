# Dodo Payments setup — from zero to seeded test payments

Follow this when setting up Resolve's payments on a **new Dodo Payments account**
(or a fresh test environment). Takes ~20 minutes, most of it paying checkout
links by hand. Commands run from the repo root.

## 1. Account

1. Go to https://dodopayments.com → sign up.
2. Stay in **Test Mode** (toggle in the dashboard) — everything Resolve does is
   test mode; the code refuses to run otherwise.

## 2. API key

1. Dashboard (in **Test Mode**) → **Developer / API Keys** → create a key.
2. ⚠️ Test keys carry **no `dodo_test_` prefix** — a test key looks exactly like
   a live key. The mode comes from the env var in step 3, not from the key.

## 3. `.env`

```
DODO_PAYMENTS_API_KEY=...
DODO_PAYMENTS_ENVIRONMENT=test_mode
```

`test_mode` is **mandatory** — the SDK defaults to live mode and 401s opaquely.
Our wrapper (`src/integrations/dodo.ts`) throws unless it is set explicitly.

## 4. Seed products, customers and payments

```
npm run seed
```

Creates the demo products, customers (Ravi / Priya / Arjun) and **checkout
links** printed to the terminal. Then the manual part:

1. Open each link in a browser and pay with test card **4242 4242 4242 4242**
   (any future expiry, any CVC, **US billing address**).
2. There is **no auto-succeed API** in test mode — paying the links by hand is
   the only way to create succeeded payments.

## 5. Verify

- Dashboard → Payments (test mode) shows the succeeded USD payments.
- `npx tsx tmp-dodo-list.ts` lists payments and which are still FREE
  (un-refunded) — each demo run consumes one.

## Gotchas

- **Checkout links expire within hours.** Mint fresh (`npm run seed`) right
  before paying — a stale link fails.
- **INR is rejected in test mode** (`PAYMENT_METHOD_UNSUPPORTED`). Seed USD;
  the agent narrates ₹ amounts (transparent dual-label, see DESIGN.md).
- **Test-mode fees drain the merchant wallet**, so FULL refunds start failing
  once the balance dips. Seed several payments; partial refunds always work
  (which is why demo refunds are partial: $14.99 of a $17.99 payment).
- One payment per demo run: idempotency is per-ticket, and each resolved case
  refunds its payment. `npm run seed:repeat` mints a fresh Ravi ticket bound to
  his newest un-refunded payment — the per-demo recipe.
- The seed scripts import the Dodo SDK directly (seeding is vendor-specific);
  runtime code goes through the `src/payments.ts` seam (`PAYMENTS=dodo`).
