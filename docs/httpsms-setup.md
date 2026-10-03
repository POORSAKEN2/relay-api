# Setting up httpSMS

How to make Relay send real texts from an Android phone with a Philippine SIM, through
[httpSMS](https://httpsms.com). Every text goes out from that phone's number, which becomes
Desert Breeze Air's sending number.

How the code works (outbox, sender loop, rules, webhook):
`docs/superpowers/specs/2026-10-04-sms-service-design.md`.

Without any of this, Relay runs with `SMS_PROVIDER=log`: nothing is sent, and each text is
printed in the `relay-api` terminal (that is how you read a sign-in code locally).

## What you need

- An Android phone with a PH SIM that has load or an unlimited-text promo.
- A free account on [httpsms.com](https://httpsms.com).
- `relay-api` running locally (see the README).
- For replies and delivery statuses only: `cloudflared` (step 5).

## 1. Set up the phone (once)

1. On the phone, download and install the app:
   https://github.com/NdoleStudio/httpsms/releases/latest/download/HttpSms.apk
   It is an APK, not a Play Store app, so allow "Install unknown apps" for your browser.
2. On your computer, sign in at [httpsms.com](https://httpsms.com) and open
   [Settings](https://httpsms.com/settings). Your **API key** is there.
3. Open the app and sign in with that API key. Allow every SMS and phone permission it asks for
   (the phone permission is what reports missed calls).
4. On the phone:
   - Battery: Settings → Apps → httpSMS → Battery → **Unrestricted**. Otherwise Android stops
     the app in the background and texts wait.
   - Keep it on Wi-Fi or mobile data, and charging during a demo.
   - Dual SIM: pick the SIM to send from in the app.
5. The phone now shows on httpsms.com with its number, for example `+639171234567`. Write it down
   in this form (`+63…`): Relay needs it exactly like that.

## 2. Check the phone sends, before Relay is involved

From PowerShell, text your own second phone:

```powershell
curl.exe -X POST https://api.httpsms.com/v1/messages/send `
  -H "x-api-key: YOUR_API_KEY" -H "content-type: application/json" `
  -d '{\"from\":\"+639171234567\",\"to\":\"+639XXXXXXXXX\",\"content\":\"httpSMS test\"}'
```

The text should arrive within seconds. If it doesn't, the problem is the phone or the app, not
Relay: check that the app is signed in, has its permissions and internet, and the SIM has load.

## 3. Tell Relay about httpSMS

In `relay-api/.env`:

```
SMS_PROVIDER=httpsms
HTTPSMS_API_KEY=YOUR_API_KEY
HTTPSMS_WEBHOOK_SIGNING_KEY=<a long random string, also used in step 5>
SEED_SMS_NUMBER=+639171234567
```

Make a random signing key with:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

The API refuses to start with `SMS_PROVIDER=httpsms` when either key is missing.

## 4. Register the sending number

Relay sends from the contractor's `active` row in `phone_numbers`. Either:

- `npm run db:seed` in `relay-api`. It **deletes all data** first, then adds the row from
  `SEED_SMS_NUMBER`.
- Or keep your data and run this in pgAdmin:

  ```sql
  insert into phone_numbers (tenant_id, number)
  select id, '+639171234567' from tenants where slug = 'desert';
  ```

Restart the API (`npm run dev`). Every 5 seconds it sends the texts that are due. Sending works
from here on; the next step only adds what comes back.

## 5. The webhook: statuses, replies, STOP and missed calls

httpSMS's servers must reach the API on your computer, so open a tunnel. Once:

```powershell
winget install --id Cloudflare.cloudflared
```

Each time (keep the window open):

```powershell
cloudflared tunnel --url http://localhost:3000
```

It prints an address like `https://abc-def.trycloudflare.com`. In httpsms.com Settings, add a
webhook:

| Field | Value |
| --- | --- |
| URL | `https://abc-def.trycloudflare.com/api/webhooks/httpsms` |
| Signing key | the same value as `HTTPSMS_WEBHOOK_SIGNING_KEY` |
| Events | every `message.*` event, plus `phone.heartbeat.offline` and `phone.heartbeat.online` |
| Phone | the demo phone |

A new tunnel gets a new address: update the webhook URL every time you start one.

Without the webhook, texts still go out but stay `queued` in Relay (nobody tells it they were
sent), and replies and missed calls are not recorded.

## 6. Try it

1. **Sign-in code.** In `/technicians`, set a technician's phone to your own (`0917 123 4567` is
   fine). Sign in as them at `http://desert.localhost:5173/sign-in/phone`: the code arrives by
   SMS.
2. **A homeowner text.** Book a job for your own number with the texts box ticked, assign it,
   and tap **On my way** as the technician.
3. **STOP.** Reply `STOP` from your phone. Later homeowner texts to you are saved as `blocked`
   with reason `opted_out`. Reply `START` to undo it.
4. **Missed call.** Call the demo phone and don't answer: a row appears in `calls`.

## Rules Relay applies

- Homeowners only get texts they agreed to (the consent box when booking online or by the
  office). A STOP blocks everything to that number until START.
- A reply to something the homeowner just did (a text-back after their call, an office reply)
  needs no consent box, but STOP still blocks it.
- Staff texts (sign-in codes, job alerts) are never blocked or held.
- Unprompted texts (booking recovery, reminders, waitlist, review requests) wait until quiet
  hours end: 21:00 to 08:00 Manila time by default (`tenants.quiet_hours_start` and `_end`).
- Links in texts point at `https://desert.<APP_DOMAIN>/`. A phone can't open `localhost`, so
  for a demo the web app also needs a public address.

## When a text doesn't arrive

Look at its row in pgAdmin:

```sql
select kind, contact, status, blocked_reason, attempts, last_error, send_after, created_at
from messages
order by created_at desc
limit 10;
```

| You see | Meaning |
| --- | --- |
| `blocked`, `no_consent` | The homeowner never ticked the consent box. |
| `blocked`, `opted_out` | They replied STOP. |
| `queued`, `send_after` later today | Quiet hours. It goes out when they end. |
| `queued`, `attempts` rising, `last_error` set | httpSMS refused it: read `last_error` (often a wrong API key or `from` number). It is tried 3 times, a minute apart. |
| `failed`, "no active sending number" | Step 4 is missing. |
| `failed`, `MOBILE_APP_INACTIVE` or `expired` | The phone was offline, or Android stopped the app. See step 1.4. |
| `queued` with a `provider_message_id`, never `sent` | httpSMS took it but the webhook doesn't reach you: check the tunnel is running and the URL is current. |
| `sent`, never `delivered` | Normal for some carriers: delivery reports aren't always sent back. |

The API logs `httpSMS phone offline` when the phone drops off.

## Limits

- Android limits how many texts an app sends in a short time, and the httpSMS app has its own
  messages-per-minute setting. Fine for a demo, not a load test.
- httpSMS's free plan has a monthly message cap. Check the current number on httpsms.com.
- Each text uses the SIM's load. Keep texts in plain characters (`'` not `’`, no emoji): one
  curly quote cuts an SMS from 160 to 70 characters, so a text can cost two or three.
- PH carriers may filter many identical texts with links as spam.

## Going back to logged texts

Set `SMS_PROVIDER=log` in `.env` and restart the API. Texts are saved and printed again, and
nothing leaves the computer.
