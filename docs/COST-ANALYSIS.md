# Cost analysis — end to end

> **Verified Aug 25, 2026** against official pricing pages (fetched live that day):
> elevenlabs.io/pricing/agents, console.groq.com/docs/models, twilio.com voice
> pricing (US + India), freshworks.com/freshdesk/pricing, dodopayments.com/pricing,
> resend.com/pricing. Internal usage numbers are **measured** from our own audit
> log (`npm run audit`), not estimated.
>
> FX assumption: **₹88 / USD** (assumed — update before quoting INR figures).
> Anything not verified from a primary source is marked **[estimate]**.

## 1. Verified price sheet (the raw inputs)

| Service | Item | Verified price |
|---|---|---|
| ElevenLabs Agents | Free plan | $0 — **15 min** of calls/month |
| ElevenLabs Agents | Starter / Creator / Pro | $6 → 75 min · $22 → 275 min · $99 → 1,238 min |
| ElevenLabs Agents | Overage (all plans) | **$0.08/min** ($0.16/min burst above concurrency) |
| Groq | `openai/gpt-oss-120b` | **$0.15 / M input tokens · $0.60 / M output** |
| Twilio | Local US number | $1.15/month |
| Twilio | Inbound to US number | $0.0085/min |
| Twilio | Outbound US → India mobile | $0.0496/min (landline $0.0699) |
| Freshdesk | Growth plan | $19/agent/month (billed annually) |
| Freshdesk | Freddy AI Copilot / AI sessions | $29/agent/mo · **$49 per 100 AI sessions** |
| Dodo Payments | Monthly / setup fees | $0 |
| Dodo Payments | Transaction fee | 4% + 40¢ US · 4% + 15¢ India · +1.5% international |
| Dodo Payments | **Refund fee** | **$1.00 per refund** (live mode) |
| Dodo Payments | Dispute | $30 per dispute |
| Resend | Free tier | 3,000 emails/month (100/day) |
| Resend | Pro | $20/mo → 50,000 emails |

Notes: ElevenLabs bills Agents by **call minutes, not the credit pool**; the
conversation-layer LLM (Gemini Flash class) is billed separately on usage —
small, but not itemized on the pricing page **[unverified, cents/call]**.
Cross-check that passed: free tier = 10k credits *and* 15 min ⇒ ~667
credits/min, which matches our measured burn (~1,000 credits per ~90 s call).

## 2. Cost per resolved case (measured usage × verified prices)

Measured on live calls: full call ~54–90 s; **727 tokens in / 141 out** per
fully guarded decision (propose + judge); 2 emails per case (OTP + confirmation).

| Cost item | Usage per case | USD | INR (@₹88) |
|---|---|---|---|
| Voice (ElevenLabs) | 1–1.5 min × $0.08 | $0.08–0.12 | ₹7–11 |
| Brain (Groq propose+judge) | 727 in + 141 out tokens | **$0.00019** | ₹0.02 |
| Emails (Resend paid rate) | 2 | $0.0008 | ₹0.07 |
| Phone leg (optional, Twilio inbound US) | 1.5 min + number amortized | ~$0.02 | ₹2 |
| **Subtotal — agent runtime** | | **~$0.10–0.15** | **~₹9–13** |
| Dodo refund fee (live mode, refund cases only) | 1 refund | **$1.00** | ₹88 |
| **Total for a refunded case on Dodo live** | | **~$1.10–1.15** | **~₹97–101** |

**The three honest findings:**

1. **AI reasoning is a rounding error** — the guarded double-LLM decision costs
   ~2 hundredths of a rupee. The guard design also cuts it further: hard-check
   denials never reach the LLM judge, and idempotent repeats cost zero
   (measured ~0.8 LLM calls/case in aggregate).
2. **Voice minutes are ~99% of the *agent's* runtime cost.** Latency work is
   cost work: every 30 s shaved off a call saves more than 1,000× the LLM bill.
3. **The payment rail dwarfs the agent.** Dodo's $1.00/refund is ~7× the entire
   runtime cost of the call that triggered it. This is vendor-specific (rails
   differ on refund fees) — exactly why `payments.ts` is a seam: the guard and
   agents don't change if a merchant's rail prices refunds differently.
   Escalations and denials never pay it at all.

## 3. Monthly cost — demo today vs production scenarios

| Component | Demo (today) | Pilot: 500 calls/mo | Small biz: 2,000 calls/mo |
|---|---|---|---|
| ElevenLabs | Free (15 min) | $60–99 (Creator+overage or Pro) | $240–299 (Pro+overage or Scale) |
| Groq | Free tier | ~$0.10 | ~$0.40 |
| Twilio (number + inbound) | — | ~$8 | ~$27 |
| Freshdesk | Free trial | $19 (1 agent, Growth) | $57 (3 agents) |
| Email | Gmail free | $0 (Resend free covers 1,000) | $20 (Resend Pro) |
| Hosting (small VPS replaces laptop+ngrok) | $0 | ~$6 **[estimate]** | ~$12 **[estimate]** |
| **Platform total** | **$0** | **~$95–135/mo** | **~$355–415/mo** |
| Per-case runtime on top | — | ~$0.10–0.15 × volume is already inside the plan minutes above | same |
| Dodo refund fees (if refunded) | $0 (test mode) | $1 × refunds | $1 × refunds |

Demo conclusion stands verified: **the entire build currently runs at $0/month.**

## 4. What a human costs for the same work — bottom-up [estimate, assumptions stated]

No third-party benchmark is cited here (the usual benchmark publishers block
automated verification); this is a transparent calculation — challenge the
assumptions, not the arithmetic.

| Assumption | Value |
|---|---|
| Fully loaded cost, India support agent (salary + overhead + tools) | ₹35,000–60,000/month |
| Productive handle time | ~120–140 hours/month |
| ⇒ Cost per productive minute | **₹4.5–8** |
| Refund-type contact: talk + verify + cross-system work + wrap-up | 8–12 min |
| Touches per resolution (callback, ticket ping-pong) | 1.5–3 |
| **⇒ Human cost per resolved refund case** | **₹55–290** |

Against Resolve's ~₹9–13 runtime per case: **roughly 5–20× cheaper**, and the
resolution happens in ~90 seconds instead of the multi-day queue — the speed
difference, not the cost difference, is what stops churn.

## 5. Market anchor (verified, not projected)

The cleanest market comparison comes from a price we verified directly:
**Freshworks sells Freddy AI Agent sessions at $49 per 100 = $0.49/session** —
and that product *answers*; it does not execute refunds. Resolve's full runtime
cost per case is ~$0.10–0.15. A guarded action agent priced anywhere near the
market's per-session rate for answer-only bots carries healthy margin, and the
action (money actually moved) justifies a premium over it, not a discount.

Deliberately **not** included: conversational-AI market-size projections
(Grand View Research and similar were inaccessible to automated verification
on Aug 25, 2026 — add a citation only after reading the source directly).

## 6. Not verified yet — do not quote as fact

- ElevenLabs conversation-layer LLM per-call surcharge (billed on usage; small)
- VPS hosting prices (marked estimate; check current Hetzner/DigitalOcean)
- DLT-registered SMS OTP rate for the India production path (industry chatter
  says ~₹0.12–0.25/SMS; verify with an aggregator before quoting)
- INR/USD rate (₹88 assumed)

## One-line summary

**Runtime ~₹10 per resolved call (voice is 99% of it, AI is ₹0.02), platform
from ~$100/month at pilot scale, and the biggest per-case cost isn't AI at all —
it's the payment rail's $1 refund fee, which only refunded cases ever pay.**
