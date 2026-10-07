# Quiet hours enforced

Date: 2026-10-05. Status: draft. Plan: `docs/superpowers/plans/2026-10-05-quiet-hours.md`.
Depends on: the SMS service (`2026-10-04-sms-service-design.md`), already built.

## Problem

The task: before sending any homeowner-facing text, check whether now falls between
`tenants.quiet_hours_start` and `tenants.quiet_hours_end` in the contractor's timezone. If so,
defer the text to after `quiet_hours_end` with a pg-boss delayed job. Staff texts (sign-in
codes, job alerts to technicians) are exempt. The columns and defaults (`21:00` to `08:00`)
already exist.

**Most of this already exists** (SMS service, commit `d9d1926` and earlier):

- `TEXT_RULES` in `src/modules/messaging/rules.ts` gives every kind a `quietHours` flag.
- `quietUntil(now, timezone, start, end)` (pure, tested in `rules.test.ts`) works out when
  quiet hours end, including windows that cross midnight.
- `sendText()` in `sms.ts` saves a held text with `send_after` = the end of quiet hours. The
  sender loop (`sender.ts`) only claims rows with `send_after <= now()`.
- Staff kinds (`sign_in_code`, `job_assigned`, `priority_alert`) skip quiet hours.
- `sms.test.ts` proves a `reminder` written at 23:00 waits until 08:00.

What is still wrong:

1. **Quiet hours are checked when a text is saved, never when it is sent.** A text saved
   outside quiet hours but sent late still goes out at night:
   - the API or the httpSMS phone is down from 20:30 to 23:00; a `reminder` saved at 20:45 goes
     out at 23:00 when the loop comes back;
   - a text saved at 20:59 fails at httpSMS; its retries at 21:00 and 21:01 go out inside quiet
     hours.

   The task says "before sending", so the check has to happen at send time too. This is the one
   real gap.
2. **Untested:** that staff texts (`job_assigned`, `sign_in_code`) are never held, even at
   night. Today only the rule table (`rules.test.ts`) says so; no `sendText()` test does.

## Goal

1. No text whose rule has `quietHours: true` reaches httpSMS while the contractor is in quiet
   hours, however late it was sent.
2. A text held at send time waits until `quiet_hours_end` and doesn't lose one of its 3 tries.
3. Staff texts, replies, visit texts and emails are never held. Same as today.
4. No schema change, no new dependency.

## Out of scope

- **Holding replies and visit texts.** The task says "any homeowner-facing text". Decided
  (2026-10-05) to keep the current split: only unprompted texts wait. A `text_back` answers a
  call the homeowner just made, a `booking_confirmation` answers a booking they just made, and
  an `on_my_way` held until 08:00 is useless. US quiet-hour rules (TCPA) are about
  solicitations, not these.
- **A pg-boss delayed job.** Decided (2026-10-05) to keep `send_after`. See Decisions.
- `new_booking_alert` stays held (`STAFF_ROUTINE`, commit `d9d1926`). It is routine office
  news, not one of the exempt staff texts the task names (sign-in codes, technician job
  alerts). The send-time check covers it too, since it reads the same rule.
- Emails. They skip quiet hours today (`emails.ts`): nobody is woken by an email.
- Daylight-saving days. `quietUntil` may be off by up to an hour on those days (noted in
  `rules.ts`). Phoenix and Manila don't use daylight saving.
- A settings screen for the quiet-hours columns. They can only be changed in the database
  today.
- The 2-hour reminder for an 8 AM visit that arrives as the window opens. Already listed in
  `docs/real-texting-todo.md`.

## Decisions

### `send_after`, not a pg-boss delayed job

`messages` is already the outbox, and `send_after` is already a delayed send stored in
Postgres. A pg-boss job would add a second place where held texts live:

- `sendText()` saves the text in the caller's transaction. A pg-boss job is created on its own
  connection, so a job could run for a change that was rolled back.
- A STOP blocks waiting texts with one update on `messages` (`blockWaitingTexts`). With jobs, it
  would also have to find and cancel them.
- Debugging a missing text would mean looking in two places.

So one mechanism: held texts are `messages` rows with a future `send_after`.

### Check again in the sender, right before handing over

In `sendDueMessages()`, for each claimed **text** whose rule has `quietHours: true`:

```
until = endOfQuietHours(tenantId)
if until: send_after = until, attempts = attempts - 1   -- wait, and give back the try
else:     deliver as today
```

- The rule is still read only from `TEXT_RULES`, and the time is still worked out only by
  `quietUntil`, so `sendText()` and the sender can't disagree.
- `claimDueMessages()` has already counted a try and pushed `send_after` a minute ahead (the
  lease). The hold replaces that `send_after` and takes the try back, so a held text keeps its
  3 tries for the morning.
- The hold only changes `send_after` and `attempts`, never `status`. If a STOP blocked the text
  between the claim and the hold, it stays `blocked`.
- If the process dies between the claim and the hold, the lease brings the row back a minute
  later and it is checked again.
- One `findQuietHours` query for each held-kind text claimed (20 per round at most). There's no
  cache: the query is cheap and a cache would be one more thing to explain.

Why not filter in `claimDueMessages()`'s SQL instead: it would mean writing the
midnight-crossing window a second time in SQL (`(now() at time zone tz)::time ...`), so the rule
would live in two places.

### `endOfQuietHours` moves to its own file

`sendText()` already has `endOfQuietHours(tenantId, tx)`. The sender needs it too, but
`sender.ts` can't import `sms.ts`: `sms.ts` imports `deliver` from `sender.ts`, so that would be
a cycle. It moves to a new `quiet-hours.ts` (a few lines), and both import it from there.

```
sms.ts ──────┬──► quiet-hours.ts ──► messaging.queries.ts  findQuietHours()
  │          │                   └─► rules.ts              quietUntil()
  └► sender.ts ┘
       └──────► messaging.queries.ts  claimDueMessages() (+ kind), holdUntil() (new)
       └──────► rules.ts              TEXT_RULES
```

## Code changes

- `quiet-hours.ts` (new): `endOfQuietHours(tenantId, tx = db)`, moved from `sms.ts`.
- `sms.ts`: imports `endOfQuietHours` from there. Behavior unchanged.
- `messaging.queries.ts`:
  - `claimDueMessages()` also returns `kind`;
  - `holdUntil(messageId, sendAfter)` (new): sets `send_after` and takes back the counted try.
- `sender.ts`: `sendDueMessages()` holds a claimed text that is in quiet hours instead of
  delivering it.

## Edge cases

| Case | Result |
|---|---|
| `reminder` saved at 23:00 | held by `sendText()` until 08:00 (as today) |
| `reminder` saved at 20:45, API down until 23:00 | sender holds it until 08:00, `attempts` back to 0 |
| `reminder` fails at 20:59, retry due at 21:00 | held until 08:00 with 1 try used, 2 left |
| `reminder` on its 3rd try, inside quiet hours | held, not `failed`. Tries again at 08:00 as its last |
| `on_my_way`, `text_back`, `booking_confirmation` at 23:00 | sent (not held) |
| `job_assigned`, `priority_alert` at 23:00 | sent (staff) |
| `sign_in_code` at 23:00 | sent by `sendText()` at once; the loop never claims it |
| `new_booking_alert` due at 23:00 | held until 08:00 (`STAFF_ROUTINE`) |
| Homeowner email due at 23:00 | sent (emails skip quiet hours) |
| STOP while a text is held | `blocked` by the webhook; the hold never touches status |
| Contractor A in quiet hours, B not | each text checks its own contractor |
| Quiet hours changed in the database while texts are held | already-held texts keep their old `send_after`; the send-time check uses the new window |
| `SMS_PROVIDER=log` | same check: a held text is held, not logged |

## Testing

- `sender.test.ts` (Date faked to 23:00 Phoenix, as in `sms.test.ts`; the database's `now()`
  stays real, so rows are still due):
  - a due `reminder` isn't handed to httpSMS; its `send_after` is 08:00 the next morning;
    `attempts` is 0;
  - a `reminder` with `attempts: 2` is held with `attempts: 2` and `status: 'queued'`, not
    `failed`;
  - due `on_my_way` and `job_assigned` texts are handed over at 23:00;
  - a due `new_booking_alert` is held;
  - an email with kind `reminder` is sent at 23:00;
  - at 14:00 a due `reminder` is handed over.
- `sms.test.ts`: at 23:00, `job_assigned` and `text_back` are saved with `send_after` now, not
  08:00.
- Existing `rules.test.ts` and `sms.test.ts` quiet-hours tests pass unchanged.
- Docs: `docs/real-texting-todo.md` and `docs/httpsms-setup.md` (quiet-hours line).
