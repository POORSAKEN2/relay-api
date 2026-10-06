# Setting up Telnyx (phone calls)

How to give Relay a phone number that rings through to the API, through
[Telnyx](https://telnyx.com). This is the base the AI receptionist builds on. For now a call to the
number is answered, hears one line ("Hello from Relay. Telnyx is connected."), and is hung up.
That proves the number, the webhook and the signature check all work.

Texts still go through httpSMS (`docs/httpsms-setup.md`). Telnyx is only for calls.

## How it works

Telnyx doesn't run a script for us. For every step of a call it posts an **event** to
`/api/webhooks/telnyx`, and the API answers with a **command** sent to Telnyx's REST API:

| Telnyx sends | Relay sends back |
| --- | --- |
| `call.initiated` (someone is calling, `direction: incoming`) | `answer` |
| `call.answered` | `speak` the test line |
| `call.speak.ended` (the line finished playing) | `hangup` |
| anything else | nothing, just 200 |

The code: `src/modules/voice/` (`voice.routes.ts` checks the signature, `voice.service.ts` picks
the command, `telnyx.ts` is the only file that sends commands to Telnyx).

Every webhook is signed. The API refuses (401) any request whose signature doesn't match
`TELNYX_PUBLIC_KEY`, or that is more than 5 minutes old.

## What you need

- A Telnyx account with a payment method (a Philippine number isn't free; see "Costs").
- A recent proof of address (utility bill, bank statement), dated within 3 months.
- `relay-api` running locally (see the README).
- `cloudflared` for the tunnel (step 4). If you set up httpSMS, you already have it.

## 1. Create the account

1. Sign up at [telnyx.com](https://telnyx.com). Choose **Philippines** as the account country:
   new accounts can only order local numbers in their own country until they reach Level 2
   verification.
2. Upgrade the account (identity check through GitHub or LinkedIn). This replaces the
   "pretrial" account, which only has AI products and a US number.
3. Billing: add a payment method and a small top-up.

## 2. Get the keys

In the [Telnyx portal](https://portal.telnyx.com), under **Keys & Credentials**:

1. **API Keys**: create one. It is shown only once, so copy it straight into `.env` (step 5).
2. **Public Key**: copy it. Telnyx signs every webhook with the matching private key.

Treat the API key like a password: it can make calls and spend your balance. It goes in `.env`
only, never in a commit.

## 3. Create the voice app and buy the number

1. **Voice → Programmable Voice → Create Voice App** (also called a Voice API Application).
   Name it `relay-dev`. Leave the webhook URL empty for now (step 4 fills it). Use API v2.
2. **Numbers → Search & Buy**: country **Philippines**, with the **Voice** feature. Buy one.
   When asked, add your address and upload the proof of address. The number may wait for
   approval before it works.
3. Open `relay-dev` → **Numbers** tab → **Assign numbers**, and pick the number.

The other tabs of `relay-dev` stay as they are:

| Tab | Setting | Value |
| --- | --- | --- |
| Inbound | SIP subdomain | empty (only for SIP phones and softphones, not used) |
| Inbound | Inbound Channel Limit | `2`: at most two calls at once, so a mistake can't run up the bill |
| Inbound | SHAKEN/STIR headers | off (US caller verification, not used) |
| Inbound | Codecs | the defaults (G722, G711A, G711U ticked) |
| Outbound | Outbound Voice Profile | empty: Relay doesn't place calls yet |
| Recording | Storage Type | Telnyx S3 (the default) |

The portal's menu names change from time to time; look for the same words.

## 4. The tunnel and the webhook URL

Telnyx's servers must reach the API on your computer. Once:

```powershell
winget install --id Cloudflare.cloudflared
```

Each time (keep the window open):

```powershell
cloudflared tunnel --url http://localhost:3000
```

It prints an address like `https://abc-def.trycloudflare.com`. In the portal, open `relay-dev`
and set:

| Field | Value |
| --- | --- |
| Webhook URL | `https://abc-def.trycloudflare.com/api/webhooks/telnyx` |
| Webhook API version | v2 |

A new tunnel gets a new address: update the webhook URL every time you start one.

## 5. Tell Relay about Telnyx

In `relay-api/.env`:

```
TELNYX_API_KEY=KEY0123...
TELNYX_PUBLIC_KEY=<the base64 public key from step 2>
```

Restart the API (`npm run dev`).

## 6. Try it

Call the number from your phone. You should hear "Hello from Relay. Telnyx is connected.", and
then the call ends. The `relay-api` terminal shows one `Telnyx call event` line per step:
`call.initiated`, `call.answered`, `call.speak.ended`, `call.hangup`.

## When a call doesn't work

| You see | Meaning |
| --- | --- |
| Nothing in the terminal, the call rings out or says the number is unavailable | Telnyx doesn't reach you. Check the tunnel is running, the webhook URL is the current tunnel address, and the number's connection is `relay-dev`. A number still waiting for approval doesn't ring through either. |
| `401` in the terminal, "Invalid webhook signature" | `TELNYX_PUBLIC_KEY` is missing or wrong (copy it again from step 2), or your computer's clock is more than 5 minutes off. |
| `call.initiated` then an error "Telnyx answer answered 401" | `TELNYX_API_KEY` is wrong or missing. |
| `call.initiated` then an error with `422` | Telnyx refused the command, often because the call already ended. Read the message after the status. |
| The call is answered but silent | `call.answered` arrived but `speak` failed: read the error in the terminal. |

A failed command answers 500, and Telnyx sends the event again. Each command carries the event's
id as its `command_id`, so a repeated event never answers or speaks twice.

## Costs

Check the current prices in the portal; Telnyx's public pages disagree with each other.
Roughly: the number has a monthly fee, and incoming calls, recording and media streaming are each
charged per minute (around $0.002 to $0.0035 a minute each, in October 2026).

## Next

- **Recording and AI disclosure:** speak the disclosure first. `call.speak.ended` is the moment
  it finished playing, so that is when `calls.disclosed_at` is set. Recording starts with the
  `record_start` command; Telnyx then sends `call.recording.saved` with the file.
- **The AI receptionist:** Telnyx can stream the call's audio over a websocket
  (`streaming_start`), and also has its own Conversation Relay and AI Assistants. Decide which
  before building it.
