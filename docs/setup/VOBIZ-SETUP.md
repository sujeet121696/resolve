# Vobiz setup — Indian phone number into the ElevenLabs agent

Follow this to give Resolve a real Indian phone number via a Vobiz SIP trunk
(the TRAI-compliant alternative to Twilio, which blocks trial accounts from
number import). Everything is dashboard config on two sites — no code or
`.env` changes. Takes ~20 minutes plus payment.

Current live values: number **+918064266330**, SIP address
**c9641e2b.sip.vobiz.ai**, trunk **resolve-inbound**.

## 1. Sign up + recharge the wallet

1. Create an account at https://vobiz.ai (start free).
2. ⚠️ The free **trial number cannot be linked to a trunk** — Vobiz
   hard-blocks it. You must buy a paid number (DID), which needs wallet
   balance first.
3. Dashboard → **Recharge wallet** → add balance. Minimum ₹500; 18% GST is
   added on top (₹600 costs ₹708, wallet gets ₹600). ₹600 covers a local
   DID's rental plus demo minutes. Payment goes through Razorpay.

## 2. Buy a phone number (DID)

1. **Buy New Phone Number** (a.k.a. Buy New DID's) → pick a **Local** number
   with **Voice** capability (Karnataka works fine).
2. Buy it from the wallet balance. If a KYC/document step appears, complete
   it immediately — verification can take days and blocks everything below.

## 3. Inbound trunk → ElevenLabs

1. **Trunks → Inbound Trunks** → create one (ours: `resolve-inbound`).
2. **Origination URIs** tab → add:

   | Field     | Value                       |
   |-----------|-----------------------------|
   | URI       | `sip.rtc.elevenlabs.io:5060`|
   | Transport | TCP                         |

   Status must show **Enabled**. This is where Vobiz forwards incoming
   calls — without it the number rings dead.
3. **Credentials** tab → create a trunk credential. Copy the **username and
   password**; ElevenLabs asks for both in the import form. (The password is
   never stored in this repo — move it dashboard-to-dashboard.)
4. **Link Numbers** → select the purchased number. (If it still says
   "Trial · Cannot Link", you're looking at the free trial number, not the
   one you bought.)

## 4. Import the number into ElevenLabs

Dashboard → **Phone Numbers → Import Number → Import from SIP Trunk**:

| Field               | Value                          |
|---------------------|--------------------------------|
| Label               | Vobiz Main Line                |
| Phone Number        | +918064266330                  |
| Transport Type      | TCP                            |
| Address             | c9641e2b.sip.vobiz.ai          |
| SIP Trunk Username  | from the Credentials tab (3.3) |
| SIP Trunk Password  | from the Credentials tab (3.3) |

The Address is your account's SIP domain — Vobiz shows it on the trunk page.

## 5. Attach the agent

On the imported number, click **Attach** → select the **Resolve** agent.

## 6. Verify — the acceptance test

1. Start the stack first: `npm run dev` (server on :3000) and ngrok on the
   static domain — otherwise the agent answers but every tool call fails.
2. Call **+918064266330** from a phone. Resolve should answer and be able to
   pull case context, send OTP, and resolve — same flow as the web widget.
3. Keep test calls short: ElevenLabs minutes are the scarce resource.

## Gotchas

- **Trial number ≠ bought number.** The account ships with a free trial
  number that can never be linked. Only paid DIDs work.
- **Wallet math:** GST is charged on top of the recharge amount but does not
  add to the balance.
- **Origination URI and Credentials tabs can silently show 0 entries** after
  trunk creation — recreate them; both are required.
- ElevenLabs webhook tools are unchanged — telephony rides on the same agent,
  tools, and `PUBLIC_BASE_URL` as the web widget. Nothing in `src/` knows
  about Vobiz.
- Watch the Vobiz balance before demo day (per-minute charges draw it down);
  the dashboard shows spends and minutes on the home screen.
