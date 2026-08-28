# ElevenLabs setup — from zero to a working voice agent

Follow this when setting up Resolve's voice agent on a **new ElevenLabs account**
(or recreating a deleted agent). Takes ~15 minutes. Commands run from the repo root.

A JSON snapshot of a known-good agent config lives at
`backup/elevenlabs-old-agent-config.json` — the values in step 4 come from it.

## 1. Account

1. Go to https://elevenlabs.io → **Sign up** with an email not already registered.
2. Verify the email, pick the **Free** plan (10,000 credits/month ≈ 6–7 demo calls).

## 2. API key

1. Dashboard → **Developers** (left sidebar) → **API Keys** → **Create API Key**.
2. If it offers permission scopes, enable **Conversational AI / Agents**
   (or leave unrestricted). A key without this permission gets 401s later.
3. Copy the key — it is shown only once.

## 3. Create the agent (blank)

1. Left sidebar → **Agents** → **New agent** → **Blank template**.
2. Name it `Resolve` (the setup script re-applies the name anyway).
3. Copy the **Agent ID** (`agent_...`) from the agent's page.

Don't configure anything else by hand — steps 4–6 do it repeatably.

## 4. Agent settings

These are NOT set by `npm run setup:voice` — set them in the dashboard
(agent page tabs), or PATCH via API from the snapshot:

| Setting | Value | Where in dashboard |
|---|---|---|
| LLM | `gemini-2.5-flash` | Agent tab |
| Language | English (`en`) | Agent tab |
| Voice | `cjVigY5qzO86Huf0OWal` (premade, same id in every account) | Voice tab |
| TTS model | `eleven_flash_v2` (English-only; Hindi still works — validated) | Voice tab |
| Security | **auth disabled / public widget access ON** | Security tab |
| Widget | full variant, bottom-right | Widget tab |

Without the Security setting the floating call bubble on `/app` silently fails.

New blank agents may already default to the right LLM/voice/TTS — check, don't assume.

## 5. `.env`

Set the two values (everything else stays as is):

```
ELEVENLABS_API_KEY=sk_...
ELEVENLABS_AGENT_ID=agent_...
```

Restart the dev server afterwards — `.env` is read only at process start
(`touch src/server.ts` nudges the tsx watcher). The web widget gets the agent id
from `GET /app-config` at page load, so no `npm run build:web` is needed.

## 6. Tools + prompt

```
npm run setup:voice
```

Creates the 4 webhook tools (`get_context`, `send_otp`, `verify_otp`,
`resolve_case`) pointing at `PUBLIC_BASE_URL/tools/*` with the `x-resolve-token`
header, and patches the agent's system prompt, greeting and tool list.
Safe to re-run any time; it finds tools by name and updates them.

Expect four `tool created:` lines and one `agent ... updated`.

## 7. Verify (cheap first)

1. `curl http://localhost:3000/app-config` → must return the NEW agent id.
2. Server + ngrok up, `npm run seed:repeat` for a fresh ticket.
3. **Text chat** in the agent's dashboard Preview panel (costs almost nothing):
   run the Ravi flow from `docs/DEMO-SCENARIOS.md` — complaint → email → OTP
   from Gmail → resolve. Proves key, agent, tools and tunnel end to end.
4. One **short voice call** (~20–30 s, greeting → email → hang up) to confirm
   audio before spending real credits.
5. Open `http://localhost:3000/app` — the call bubble should appear bottom-right.

## Gotchas

- Tool/param descriptions must be **quote-free** (quotes break tool configs) —
  already handled inside `setup-voice.ts`; keep it that way when editing.
- Each tool param can have exactly ONE value source; `conversation_id` is filled
  by the platform via `dynamic_variable: system__conversation_id`.
- If `PUBLIC_BASE_URL` doesn't match the live ngrok tunnel, every tool call 404s
  and the agent **improvises — which sounds like it worked**. Check first.
- Voice credits don't reset until the monthly anniversary; record every call.
