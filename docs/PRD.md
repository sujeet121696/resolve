# Resolve — Product Requirements

## Problem

Support tickets about money (refunds, returns) take days of email back-and-forth, even when the merchant's policy already decides the answer. Agents describe the fix; someone else executes it later.

## Product

A support agent that answers a customer by voice, phone, or chat, verifies who they are, pulls their case, decides under the merchant's policy, and **executes** the resolution mid-conversation — refund through Dodo Payments, ticket updated in Freshdesk, confirmation by voice and email.

Target: under 90 seconds per resolved case.

## Users

- **Customer** — calls or chats with a problem about an order.
- **Merchant / ops** — sets policy limits in the Admin console, watches decisions live in the Ops view, reads the audit trail.
- **Human support agent** — receives escalated tickets with a structured briefing.

## Requirements

1. **Identity** — email OTP verification before any money-moving action. Two wrong codes lock the session.
2. **Context** — ticket found by the verified email; order facts from the order system (Shopify, read-only, or local data).
3. **Decision** — an LLM resolution agent proposes; an independent policy guard runs hard checks, then a judgment call.
4. **Hard checks, in order** — `unverified` → `auto_limit` → `no_payment` → `return_window_expired` → `awaiting_return`.
5. **Execution** — approved refunds go through Dodo; one action per ticket (idempotent).
6. **Returns** — a returnable physical item holds the refund until the return is received, then releases it.
7. **Escalation** — any other denial goes to a human: prioritized ticket, structured briefing, self-scheduled follow-up.
8. **Policy as config** — limits live in `config/policy.json` and the Admin console, not code.
9. **Audit** — every decision is written to an append-only trail.

## Demo scope (locked 2026-09-24)

Exactly four flows, on real Shopify data (`OMS=shopify`):

| Flow | Outcome |
|---|---|
| Refund | clean auto-approve, Dodo refund |
| Hold | return required, RMA raised, no money moves yet |
| Escalate | over the auto-limit → human |
| Blocked | duplicate refund caught by the safety check |

Don't expand beyond these without an explicit decision.

## Out of scope

- Plan changes (typed and guard-checked, but returns `unsupported`), replacements/exchanges, real courier booking.
- WhatsApp, multi-tenant auth, analytics dashboards.
- Any override path from the conversation — money never moves without OTP, ownership, policy, and guard approval.
- Live ticket creation (only seed scripts create tickets).
- Writing back to Shopify (`read_orders` scope only, by design).
