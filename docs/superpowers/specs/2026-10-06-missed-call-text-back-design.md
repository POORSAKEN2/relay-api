# Missed-call text-back

Date: 2026-10-06. Status: proposed. Plan: `docs/superpowers/plans/2026-10-06-missed-call-text-back.md`.
Depends on: nothing new. Roadmap: `specs/2026-10-06-mvp-remaining-work.md` (step 1).

## Problem

MVP module 3: "Detects missed and abandoned calls. Sends a text within 30 seconds with a booking
link pre-filled with the caller's number."

What already exists:

- httpSMS posts `message.call.missed` to `/api/webhooks/httpsms`. `webhooks.service.ts →
  recordMissedCall` finds the contractor by the phone's own number (`phone_numbers`) and inserts
  a `calls` row with `answered_by = null`. A caller who hung up while it rang is the same event.
- `sendText()` (`messaging/sms.ts`) with kind `text_back`. Its rule (`messaging/rules.ts`) is
  `REPLY`: allowed unless the caller texted STOP, never held for quiet hours.
- The sender loop sends saved texts every 5 seconds (`messaging/sender.ts`, `ROUND_MS`).
- `messages.call_id` ("the call a text-back answers") and the recovery analytics count a missed
  call as handled once a `text_back` with that `call_id` is `sent` or `delivered`.
- `jobs.source` has `text_back`, and `jobs.call_id` links a job to its call.

What is missing: nothing sends the text, the booking page ignores the caller's number, and a
booking made from the link is saved as `web`, so it never counts as recovered.

## Goal

1. A missed call with a caller number gets one text within 30 seconds:
   "Desert Breeze Air: sorry we missed your call. Book a visit here: <link> Reply STOP to opt out."
2. The link opens the booking page with the phone already filled in.
3. A booking made from that link is saved with `source = 'text_back'` and `call_id` set, so it
   shows on the recovered-revenue dashboard and in the per-job fee.
4. The core is provider-free: the future Twilio webhook calls the same function.

## Out of scope

- The missed-caller reminder (next morning, if they didn't book). Separate roadmap item.
- Texting back callers whose call the AI answered. They are not missed calls.
- The Twilio webhook. It arrives with the phone line (`specs/2026-10-06-twilio-phone-line-design.md`).

## Design

### One core function, in a new `calls` module

```
messaging/webhooks.service ─► calls/calls.service  textBackMissedCall()
                                    ├► messaging/sms.ts        sendText()
                                    └► lib/tenant-url.ts       tenantUrl()
```

`textBackMissedCall(tenantId, callId, tx)`: for a saved missed call, decide whether to text and
save the text. The httpSMS webhook inserts the call, then calls it in the same transaction.
Later the Twilio status webhook does the same once a call ends unanswered.

Steps:

1. Load the call and the contractor (name, slug, custom domain). Stop if the call has no
   `from_phone` (hidden caller ID) or `answered_by` is not null.
2. Stop if this caller already got a `text_back` from this contractor in the last 12 hours
   (any status but `blocked`). Someone who rings three times in five minutes gets one text.
3. `sendText(tenantId, { contact, kind: 'text_back', body, callId, customerId })`. The compliance
   gate blocks it if the caller texted STOP; the blocked row stays as the record.

The insert of the call becomes `insertMissedCall(...)` returning the new id, or `undefined` when
the call was already saved (a repeated webhook). No id, no text.

### The link

```
https://desert.garified.com/?call=<callId>&phone=%2B16025550111
```

Built with `tenantUrl(tenant, path)`, so a verified custom domain is used when there is one.

- `phone` pre-fills the contact step. Only the caller's own number, which they already know.
- `call` is the call's id (a random UUID). The booking page sends it back with the booking.

### Booking from the link

`BookingInput` gets an optional `callId`. `bookVisit` looks it up:

- a call of **this** contractor, with `answered_by is null`, that started in the last 7 days
  → `source = 'text_back'`, `jobs.call_id = callId`;
- anything else (unknown id, another contractor's call, answered call, too old) → ignored, the
  booking is a normal `web` booking. A bad id never stops a booking.

The draft keeps the call id too (`booking_drafts.answers.callId`) so a homeowner who stops and
comes back through a recovery text still books as `text_back`. Answers are already a JSON
object, so no schema change.

### Message body

```
${tenantName}: sorry we missed your call. Book a visit here: ${link} Reply STOP to opt out.
```

One SMS segment is 160 characters (GSM-7); with a long name and link it may be two. Acceptable.

## Data

No schema change. `sendText()` gets an optional `callId` passed through to `messages.call_id`.

## Edge cases

| Case | Result |
|---|---|
| Caller ID hidden | call saved, no text |
| Same webhook twice | one call, one text |
| Caller rang 3 times in 5 minutes | 3 calls, 1 text |
| Caller rang again 13 hours later | second text |
| Caller texted STOP earlier | text saved as `blocked` (`opted_out`), not sent |
| Night time | sent anyway (`text_back` skips quiet hours: they just called) |
| Number belongs to no contractor | logged, ignored (as today) |
| Booking with a valid `callId` | `source = 'text_back'`, `call_id` set |
| Booking with a `callId` of another contractor / unknown / answered call / older than 7 days | `source = 'web'`, no `call_id` |
| Link opened, booking left unfinished, resumed from recovery text | still `text_back` (draft kept the id) |

## Testing

- `calls.test.ts`: `textBackMissedCall` against the test DB: text saved with `call_id`, kind,
  body containing the link; no text for hidden caller ID, answered call, a text-back in the last
  12 hours; a blocked text-back doesn't count as "already texted".
- `webhooks.test.ts`: the existing `message.call.missed` test also checks one queued `text_back`;
  a repeated event makes no second text.
- `online-booking.test.ts`: booking with a valid `callId` gives `text_back` and `call_id`; each
  invalid case gives `web`.
- `relay-web` `steps.test.ts` (or a new small test): the initial answers take `phone` from the
  link when there is no saved draft.
