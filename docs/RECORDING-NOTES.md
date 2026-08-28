# Recording notes

Scenario scripts live in `docs/DEMO-SCENARIOS.md`. This is only what matters while
a camera is running.

## Audio capture — the thing that ruins these recordings

macOS screen recording (Cmd-Shift-5) captures **the microphone, not system audio**,
and **Microphone defaults to "None"** — set it explicitly under Options, or you
record silence.

No BlackHole or Loopback on this machine, so the route is **play the agent through
speakers and record with the mic**. Keep the volume moderate: at high volume the
browser's echo cancellation can misfire and the agent starts talking over itself.

**Record ten seconds and play it back before the real take.**

## Voice minutes are the scarcest resource

ElevenLabs free tier, Aug 22 2026: **8,604 / 10,000 used, ~1,396 left, no reset
until Sept 19.** At ~1,000 credits per ~90-second call that is **about one call.**

So: **A on voice, B on chat, C over HTTP.** B and C cost nothing. Rehearse A's
dialogue on chat, remembering every A run burns a Dodo payment either way.

**Record every call, even the ones you think are rehearsals.** A clean 54.5 s call
ran on Aug 22 uncaptured — that footage is gone and cost a ninth of the month.

Staying on `eleven_flash_v2`, the config that produced a clean call. It is
ElevenLabs' **English-only** model, so the Hindi is pronounced by a model with no
Hindi in it; `eleven_flash_v2_5` is the multilingual one. Switch when there are
credits to validate it.

## Measured — quote the right number

| Beat | Measured |
|---|---|
| Full voice call, `context.loaded` → `case.resolved` | **54.5 s** (ticket #12) |
| Guard beat, `case.received` → `guard.approved` | **1.57 s** voice · 1.79 s HTTP · 4.8 s on an earlier call |
| Whole tool call over HTTP | 9.4 s, of which **~4.6 s is the confirmation email** |

The guard beat varies, so **say the number your ops view is showing on the take you
record.** The email send is deliberately on the critical path so the agent never
claims an email it hasn't sent — cover the wait with filler speech rather than
cutting it.

## Prep

1. Stacked watchers fight over :3000 (`EADDRINUSE`, or silently stale code):
   ```bash
   ps -o pid,ppid,etime,command -ax | grep "[t]sx" | grep RND/resolve
   lsof -nP -iTCP:3000 -sTCP:LISTEN     # which PID actually owns the port
   ```
   Keep the watcher whose child owns :3000; `kill <pid>` the others by PID.
   **Never `pkill -f tsx`** — other projects on this machine run tsx too.
2. `npm run build:web` if anything under `web/` changed.
3. Voice only: ngrok up, `PUBLIC_BASE_URL` matching the tunnel. If they disagree
   every tool call 404s and the agent improvises — which *sounds* like it worked.
4. `npm run seed:repeat -- --returned` before each A run. **The flag is not
   optional for the refund take:** earbuds are physical, so without it the guard
   holds the money at `awaiting_return` and the agent arranges a return pickup
   instead — correct, but not the shot at 0:43.
5. Gmail open before you start: OTP is **5-minute TTL, 2 attempts**.
   **Warm the SMTP connection first** — the first send after a laptop wake can
   take >20 s and time out the tool (seen live Aug 25):
   ```bash
   curl -X POST localhost:3000/otp/send -H "Content-Type: application/json" \
     -d '{"conversation_id":"warmup","email":"ravi.test@example.com"}'
   ```
   **Then DELETE every old verification-code email** before the take. A locked
   call on Aug 25 came from reading a stale code out of a crowded inbox — during
   the call, trust only the NEWEST email (check its timestamp).
6. Tabs left to right: `/app` · `/app/ops` · Dodo dashboard · Freshdesk ticket · Gmail.

## Shot order — target 1:50, never 2:00

Platforms truncate, and a cut-off ending reads as carelessness.

| Time | On screen |
|---|---|
| **0:00–0:10** | The call already in progress, Ravi in Hindi. **Real call audio, no voice-over** — let it breathe |
| 0:10–0:19 | Ops view: `case.received`, context arriving from Freshdesk |
| 0:19–0:33 | Split: agent asking for the code · Gmail · Ravi reading digits aloud |
| 0:33–0:43 | Ops view: `agent.resolution.proposed` → `guard.approved`, timing visible |
| **0:43–0:54** | **Dodo dashboard refreshing — the refund appears.** Then `case.resolved` |
| 0:54–1:02 | Freshdesk private note, then the Gmail confirmation with the reference |
| **1:02–1:20** | **Scenario B on chat.** Priya, ₹18,999 → `guard.denied` (`auto_limit`) beside it |
| **1:20–1:42** | **The attack.** `curl` with `amount: 5000000, verified: true, override: "admin"` → `proposed` then `denied` (`unverified`) |
| 1:42–1:50 | Architecture slide |

Nothing in the refund compresses below ~62 s — the OTP round trip and the Dodo
refresh both have to be real time to be believable. The two refusals are not
redundant: **B** is refusal as *policy* (a legitimate request it isn't authorised
to decide, ending in a human handoff), **C** is refusal as *defense*. Both show
`agent.resolution.proposed` immediately before the denial — the resolution agent
wanted to say yes, and the guard is what stood between it and the money.

## The return loop — a third refusal, if there's room

The strongest new beat is the return gate: the agent declines to pay, arranges
the pickup itself, refuses to raise a second one, and pays only after the
warehouse scan (`docs/RUNBOOK.md` §6b). It is the answer to the first question a
judge asks about refund automation — *you don't pay before the goods come back.*

It does not fit in 1:50 as a fourth beat. Options, in order of preference:
**(a)** say it in one line over the existing 0:43 refund shot — "this refund only
fired because the return was already scanned in"; **(b)** trade the 0:54–1:02
Freshdesk/Gmail beat for a 12-second version of it; **(c)** leave it for the
Stage 2 video and the written submission. Do not try to squeeze all four.

## If voice misbehaves on the day

Record the chat channel instead (`/app/chat`, same brain, same guard) and open
with a short piece of voice audio. Weaker, but a complete story — and far better
than a broken take. A bad call day must not mean no submission.

## Honesty in the edit

- **Label every cut.** The call runs ~90 s, much of it waiting for a human to read
  six digits. Cutting that is normal; implying it never happened isn't.
- **Do not speed up the Dodo dashboard.** The refund appearing has to be real time.
