# SMS service: real texts through httpSMS

Date: 2026-10-04. Status: draft. Schema draft: `2026-10-04-sms-service-schema.sql`.

## Problem

`sendText()` in `src/modules/messaging/sms.ts` saves a `queued` row to `messages` and logs it.
Nothing leaves the system. Sign-in codes, booking recovery and the technician's on-my-way,
running-late and no-access texts all call it today, and about 15 more items in the MVP list
(confirmations, reminders, text-back, alerts, the inbox) are waiting on it.

The demo runs in the Philippines, so it uses httpSMS: an Android phone with a local SIM runs
the httpSMS app, and Relay sends through httpSMS's cloud API. Every text goes out from that
phone's number.

Two things in the code stand in the way:

1. `sendText()` runs inside the caller's transaction. A real send can't be rolled back, and an
   HTTP call inside a transaction holds it open while it waits on the network.
2. Phones are US-only: `UsPhone` in `src/lib/fields.ts` adds `+1`, the booking page shows a
   fixed `+1` box, and the demo contractor's timezone is `America/Phoenix`.

## Goal

1. `sendText()` keeps its signature, so the current callers need no change. It decides whether
   the text may go out and saves it; it never calls the network.
2. A **sender loop** sends saved texts through httpSMS a few seconds later, retries failures,
   and gives up after 3 tries.
3. A **webhook** records what happened next: sent, delivered, failed, replies (including STOP and
   START), and missed calls.
4. PH mobile numbers work everywhere a phone is typed, and US numbers keep working.
5. Without a phone or keys (tests, most developers), everything still runs: texts are logged,
   not sent.

## Out of scope

Built later on top of this, each as its own task:

- The features that send new kinds: booking confirmation, 24 h / 2 h reminders, `job_assigned`,
  office alerts, waitlist offers, review requests.
- Missed-call text-back (module 3). The webhook stores the `calls` row; sending the `text_back`
  is that feature's job.
- The two-way inbox screen. The webhook stores inbound texts so the inbox has data.
- Email.
- US texting: Twilio, 10DLC, the telecom lawyer's review of the consent wording.
- More than one sending phone per contractor.
- Fixing `bookingLink()` in `online-booking.service.ts`: it always builds `https://<host>/`, so
  for a local demo the homeowner's phone needs the web app on a public address (a tunnel or a
  deploy). Decide that separately.

## How a text travels

```
caller ─ sendText() ─► messages row          (caller's transaction; no network)
                       status queued / blocked, send_after
                                │
sender loop, every 5 s ─────────┘  claim due rows ─► httpSMS POST /v1/messages/send
                                   store provider_message_id   (still 'queued')
                                │
httpSMS webhook ────────────────┘  message.phone.sent ─► 'sent'
                                   message.phone.delivered ─► 'delivered'
                                   message.send.failed / .expired ─► 'failed'
```

`messages` is the outbox. No new status values are needed:

| State | `status` | `provider_message_id` |
| --- | --- | --- |
| Saved, waiting for the sender loop | `queued` | null |
| httpSMS took it; the phone hasn't sent it yet | `queued` | set |
| The phone sent it | `sent` | set |
| The carrier confirmed it | `delivered` | set |
| 3 failed tries, or the phone failed or gave up | `failed` | maybe |
| The rules stopped it (never sent) | `blocked` | null |

A status only moves forward (`queued` → `sent` → `delivered`; anything → `failed`), so a late
`sent` webhook never undoes a `delivered`.

## Data

Schema draft: `2026-10-04-sms-service-schema.sql`. Migration `0011`.

`messages` gains three columns:

| Column | Meaning |
| --- | --- |
| `send_after` | When the sender may send it. `now()` for most texts; the end of quiet hours for texts written during them; pushed 1 minute forward on each try. |
| `attempts` | Tries to hand it to httpSMS, 0–3. |
| `last_error` | The last error from httpSMS or the phone, for whoever looks at a failed text. |

Plus the partial index `messages_due_idx (send_after) where status = 'queued' and
provider_message_id is null`, which is exactly the sender loop's query.

`webhook_events.provider` allows `'httpsms'`.

The sending number is the contractor's `active` row in `phone_numbers`. Nothing new is needed
there; the Twilio-only `provider_sid` stays null. Seed adds one row for `desert` from
`SEED_SMS_NUMBER` when it is set, and sets `desert`'s timezone to `Asia/Manila`.

## Settings (`src/config/env.ts`)

| Variable | Meaning |
| --- | --- |
| `SMS_PROVIDER` | `log` (default) or `httpsms`. `log` sends nothing and prints each text in development, as today. Tests always use `log`. |
| `HTTPSMS_API_KEY` | From httpSMS settings. Required when `SMS_PROVIDER=httpsms`. |
| `HTTPSMS_WEBHOOK_SIGNING_KEY` | The signing key typed when creating the webhook in httpSMS. Required when `SMS_PROVIDER=httpsms`. |
| `SEED_SMS_NUMBER` | Optional. The demo phone's number in E.164, used by `db:seed` only. |

## Phones: `Phone` replaces `UsPhone`

`src/lib/fields.ts`. One parser, used by every module that takes a phone today (booking,
customers, import, team, settings, sign-in). Spaces, dashes, dots and brackets are ignored.

| Typed | Stored | Why |
| --- | --- | --- |
| `0917 123 4567` | `+639171234567` | PH mobile, local form: 11 digits starting `09`. |
| `639171234567` | `+639171234567` | PH mobile without the `+`. |
| `+63 917 123 4567` | `+639171234567` | Starts with `+`: any valid E.164 is kept. |
| `(480) 555-0199` | `+14805550199` | 10 digits starting 2–9: US, as today. |
| `1 480 555 0199` | `+14805550199` | 11 digits starting `1`: US. |

Anything else: "Enter a mobile number, like 0917 123 4567". A bare 10-digit `917…` is read as
US, because 917 is also a New York area code; a PH number needs its leading `0` or `63`.

Web:

- `formatPhone()` in `src/lib/format.ts` also shows `+639171234567` as `0917 123 4567`.
- The booking contact step loses its fixed `+1` box (`UsPhoneInput`, `UsFlag`) and becomes a
  plain phone field with the placeholder `0917 123 4567`.

## `sendText()`: decide and save

Same signature and callers as today. In the caller's transaction:

1. Work out the **rule** for the kind (`src/modules/messaging/rules.ts`, pure, tested):

   | Group | Kinds | Consent | Quiet hours |
   | --- | --- | --- | --- |
   | Staff | `sign_in_code`, `job_assigned`, `new_booking_alert`, `priority_alert` | not checked | not checked |
   | Reply to the homeowner's own action | `text_back`, `manual` | only an opt-out blocks | not checked |
   | Unprompted | `abandoned_booking`, `missed_caller_reminder`, `waitlist_offer`, `reminder`, `payment_reminder`, `review_request` | must be granted | deferred |
   | Every other homeowner kind | `booking_confirmation`, `booking_changed`, `on_my_way`, `running_late`, `job_started`, `no_access`, `invoice`, `card_link` | must be granted | not checked |

   A missed caller and a homeowner who texted in never filled in the booking form, so they have
   no consent row; replying to them is allowed unless they texted STOP.

2. **Consent:** the newest `consent_events` row for (contractor, phone, `sms`). None →
   `blocked` / `no_consent`. `granted = false` → `blocked` / `opted_out`.
3. **Quiet hours:** if now is between `tenants.quiet_hours_start` and `quiet_hours_end` in the
   contractor's timezone (the window may cross midnight), `send_after` = the next
   `quiet_hours_end`. Pure helper `quietUntil(now, timezone, start, end)`, worked out in
   minutes of the local day. Manila has no daylight saving, so the rare DST hour isn't handled.
4. Insert the row: `queued` with `send_after`, or `blocked` with `blocked_reason`.

**Sign-in codes are sent right away, not by the loop.** The code is never stored, so the loop
would have nothing to send. `sendText()` saves the masked row as today and then, outside any
transaction (the sign-in route doesn't use one), calls httpSMS with the real body and updates
the row. The loop's query skips `sign_in_code`.

## The sender loop

`src/modules/messaging/sender.ts`, started and stopped in `server.ts` beside `startJobs()`.
Not a pg-boss cron: those run once a minute at most, and a text-back has to leave within 30
seconds.

Every 5 seconds, `sendDueTexts()`:

1. **Claims** up to 20 rows in one statement, so no transaction is held during the HTTP call:

   ```sql
   update messages set attempts = attempts + 1, send_after = now() + interval '1 minute'
   where id in (
     select id from messages
     where status = 'queued' and provider_message_id is null and send_after <= now()
       and kind <> 'sign_in_code'
     order by send_after limit 20
     for update skip locked
   )
   returning ...
   ```

   Pushing `send_after` is the lease: if the process dies mid-send, the row comes back a minute
   later. Two API instances never claim the same row.

2. For each row, finds the contractor's `active` sending number and calls the provider.
   - Success: store `provider_message_id`. Status stays `queued` until the phone reports.
   - Error, under 3 tries: store `last_error`; it is tried again a minute later.
   - Error on the 3rd try, or no sending number: `failed` with `last_error`.

3. Waits 5 seconds after the round ends (`setTimeout`, not `setInterval`), so a slow round
   never overlaps the next one.

Known gap: if httpSMS takes a text and the process dies before saving its id, the retry sends it
twice. Fine for a demo.

## The provider: `src/modules/messaging/httpsms.ts`

One function, `sendSms({ from, to, content, requestId })`, a plain `fetch`:

- `POST https://api.httpsms.com/v1/messages/send`, header `x-api-key`, body
  `{ from, to, content, request_id }`.
- `request_id` is our `messages.id`. httpSMS sends it back in every webhook, so a status update
  finds its row even before `provider_message_id` is saved.
- Returns httpSMS's message `id`; throws on any non-2xx with the response text as the error.
- 10-second timeout.

With `SMS_PROVIDER=log` the sender calls a `log` version instead: it marks the row `sent` and, in
development, prints the recipient and body (how developers read sign-in codes).

No provider interface: moving to Twilio later means replacing this one file.

## Webhook: `POST /api/webhooks/httpsms`

`src/modules/messaging/webhooks.routes.ts`. No session or tenant host: httpSMS calls it.

1. **Check the signature.** `Authorization: Bearer <JWT>`, HS256, signed with
   `HTTPSMS_WEBHOOK_SIGNING_KEY`. Verified with the `jose` package (`jwtVerify`, algorithms
   `['HS256']`). Missing or wrong → `401`. The token doesn't cover the body, so this proves the
   caller knows the key, nothing more.
2. **Ignore repeats.** Insert (`'httpsms'`, the event's `id`) into `webhook_events`; if it was
   already there, answer `200` and stop. httpSMS retries up to 4 times when it doesn't get a
   `200` within 5 seconds.
3. **Find the contractor** by `data.owner` in `phone_numbers` (`active`). Unknown number: log a
   warning and answer `200` so httpSMS doesn't retry.
4. **Handle the event** (`X-Event-Type`, also the body's `type`):

   | Event | What happens |
   | --- | --- |
   | `message.phone.sent` | Row → `sent`. |
   | `message.phone.delivered` | Row → `delivered`. |
   | `message.send.failed` | Row → `failed`, `last_error` = `data.error_message`. |
   | `message.send.expired` | Only when `data.is_final`: row → `failed`, `last_error` = `'expired'`. |
   | `message.phone.received` | New `messages` row: `inbound`, kind `inbound`, status `received`, `customer_id` matched by phone. Then STOP or START, below. |
   | `message.call.missed` | New `calls` row: `provider_sid` = `data.message_id`, `from_phone` = `data.contact`, `to_phone` = `data.owner`, `answered_by` null, `started_at` = `data.timestamp`, `customer_id` matched by phone. |
   | `phone.heartbeat.offline` | Warning log: texts will wait until the phone is back. |
   | anything else | Ignored, `200`. |

   The row for a status event is found by `data.request_id` (our id), else by
   `provider_message_id` = `data.id` (sent, delivered, failed) or `data.message_id` (expired).
   Field names differ between events in httpSMS's own payloads; the handler reads both.

**STOP and START.** The reply's text, trimmed and upper-cased:

- `STOP`, `STOPALL`, `UNSUBSCRIBE`, `CANCEL`, `END`, `QUIT` → `consent_events` row,
  `granted = false`, `source = 'sms_reply'`, `message_id` = the inbound row.
- `START`, `UNSTOP` → the same with `granted = true`.

No reply text is sent back. Every later `sendText()` honors it through the consent check.

**Local webhook testing needs a tunnel** (cloudflared or ngrok) to the API, set as the webhook
URL in httpSMS. Sending works without one; statuses, replies and missed calls don't.

## Writing texts for a phone

- Keep bodies in plain GSM characters: a curly `’` or an emoji switches the whole text to
  Unicode, which cuts each SMS part from 160 to 70 characters and can double the cost. Use `'`
  in text bodies (the app's screens can keep `’`).
- Keep links short and the wording varied; PH carriers filter repeated link texts as spam.

## Limits to check before demo day

- Android limits how many texts an app sends in a short time (about 30 per 30 minutes by
  default), and the httpSMS app has its own messages-per-minute setting. Fine for a demo, not a
  load test.
- httpSMS's free plan has a monthly message cap; check the current number on its pricing page.
- The phone must stay powered, online, with the app allowed to run in the background. Offline
  too long and texts come back as `message.send.expired`.
- Delivery reports depend on the carrier, so some texts never reach `delivered`.

## What changes for existing code

- `sendRecoveryTexts()`: no change. Marking the draft and saving the text in one transaction is
  now exactly right, since the text is sent only after it commits.
- `textHomeowner()` in technician-jobs: no change.
- `requestSignInCode()`: no change; `sendText()` sends sign-in codes itself.
- `docs/real-texting-todo.md`: tick what this builds; keep the US-only items (Twilio, 10DLC,
  legal review) under a "US launch" heading.

## Tests

- `fields.test.ts`: every row of the phone table, plus refusals.
- `rules.test.ts`: the group of every kind in `MESSAGE_KINDS` (a new kind fails the test until
  it is placed), and `quietUntil` before, inside and after a window that crosses midnight.
- `sms.test.ts`: `sendText()` blocks with `no_consent` and `opted_out`, lets staff kinds and
  replies through, sets `send_after` during quiet hours.
- `sender.test.ts` (the httpSMS module mocked with `vi.mock`): a claimed row gets its provider id,
  a failure is retried, the 3rd failure is `failed`, a row without a sending number is
  `failed`, blocked and future rows are never claimed.
- `webhooks.test.ts` (supertest, tokens signed with `jose`'s `SignJWT`): `401` without or with a
  wrong token, a repeated event is ignored, each status event moves the row and never backwards,
  STOP and START write consent, an inbound text and a missed call are stored, an unknown owner
  answers `200`.

## New dependency

`jose` (no dependencies of its own), for the webhook signature.

## Build order

1. Phones: `Phone` in the API, `formatPhone` and the booking field in the web app.
2. Migration `0011`, env settings, seed (Manila, sending number).
3. `rules.ts` and the new `sendText()`.
4. `httpsms.ts` and the sender loop. The existing three callers now really send.
5. The webhook.
