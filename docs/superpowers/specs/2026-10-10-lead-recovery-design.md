# Lead recovery: next-morning texts and the safety stop

Date: 2026-10-10. Status: built. Plan: `docs/superpowers/plans/2026-10-10-lead-recovery.md`.
Depends on: nothing new. Roadmap: `specs/2026-10-06-mvp-remaining-work.md` (module 5, and
"after the receptionist" item 5). Repos: `relay-api` and `relay-web`.

## Problem

MVP module 5, lead recovery: a homeowner who stopped partway through booking, or a caller nobody
answered, gets one text the next morning with three open arrival windows and a link to book.

What already exists:

- The abandoned-booking text. The `booking-recovery` job (every 5 minutes, `jobs/index.ts`)
  calls `sendRecoveryTexts()` (`online-booking.service.ts`). A draft with consent that has been
  quiet 60 minutes (`RECOVERY_WAIT_MINUTES`), was begun in the last 24 hours
  (`RECOVERY_CUTOFF_HOURS`), isn't booked, and has no job for its phone since it began, gets
  "<name>: you started booking a visit. Finish here: <link> Reply STOP to opt out." The text and
  `booking_drafts.recovery_texted_at` are saved in one transaction. The sender loop sends it.
- The `missed_caller_reminder` message kind, with the `UNPROMPTED` rule (consent required, held
  for quiet hours, `messaging/rules.ts`). Nothing sends it.
- `textBackMissedCall()` (`calls/calls.service.ts`): the immediate text-back, with the link
  `/?call=<id>&phone=<phone>` that makes a booking count as recovered (`CALL_LINK_DAYS` = 7).
- `listOpenWindows(tenantId, days)` (`online-booking.queries.ts`): open arrival windows, sorted.
- `quietUntil()` (`messaging/rules.ts`) and each contractor's `quiet_hours_start` /
  `quiet_hours_end` (default 21:00 / 08:00) and `timezone`.
- The gas / carbon monoxide safety screen (`SafetyStop` in relay-web
  `features/booking/problem-step.tsx`). It only changes what the page shows.

What is wrong or missing:

1. The abandoned-booking text goes 60 minutes after the homeowner stops, not the next morning,
   and lists no open windows.
2. A homeowner who answered "Yes" to the gas question has a draft, so they get "finish your
   booking" right after being told not to book online.
3. Nothing sends the missed-caller reminder.

## Goal

1. The abandoned-booking text goes once, the first morning after the draft went quiet, and lists
   the next three open windows.
2. A draft that reached the safety screen is never texted, unless the homeowner said it was a
   mistake and carried on.
3. A missed caller who didn't book and has agreed to texts gets one reminder the next morning, in
   the same format, with the text-back link.

## Out of scope

- Recovery timing or an on/off switch as contractor settings. They stay constants.
- A second reminder, or a recovery email.
- Changing consent for missed callers. `missed_caller_reminder` stays `UNPROMPTED` (consent
  required) until the lawyer answers question 2 of the roadmap. Most missed callers have no
  consent, so most won't get the reminder. That is intended.
- The wizard's Exit dialog wording ("We'll text you a link to finish").

## Design

### "The morning"

The morning is the moment the contractor's quiet hours end (`quiet_hours_end`, in its
`timezone`). New in `messaging/rules.ts`, next to `quietUntil()` and using the same
`secondsOfDay()`:

```ts
// The most recent moment quiet hours ended, at or before `now`. Daylight-saving days are off by
// up to an hour, as for quietUntil.
export function lastMorning(now: Date, timezone: string, end: string): Date
```

It returns `now` minus the seconds since `end` local time (mod one day). Examples, timezone
`America/Phoenix`, end `08:00:00`: at 10:30 local it returns 08:00 today; at 07:00 local it
returns 08:00 yesterday; at 08:00 exactly it returns `now`.

The previous morning is `lastMorning − 24 hours`.

### Who is due, and when

The job runs every 5 minutes, as today. For each contractor that is not suspended and not in quiet
hours right now (`quietUntil(...) === null`), with `morning = lastMorning(now, …)`:

- **Range:** the draft's `last_activity_at` (or the call's `started_at`) is at or after
  `morning − 24h` and before `morning`.
- **Gap:** it is also at least 60 minutes ago (`RECOVERY_WAIT_MINUTES`, kept). A draft dropped at
  07:59 with an 08:00 morning is texted at 08:59, not a minute later.

Each draft and call gets exactly one chance, on one day. A job that is down for the whole day
skips that day's leads instead of texting them a day late. `RECOVERY_CUTOFF_HOURS` goes away, and
so does the `createdAt` cutoff in `listDraftsToRecover`.

The texts are written while the job runs, during the contractor's day, so the windows they list
are open when the text goes out. `sendText()` still holds an `UNPROMPTED` text if quiet hours
begin in between.

### Open windows in the text

New `online-booking/recovery.ts` holds what both texts share: `listDueTenants(now)` (the due
contractors, each with its `since` and `before`) and `nextOpenWindows(tenantId)`: the first 3 rows
of `queries.listOpenWindows(tenantId, DAYS_AHEAD)`, each as `'Tue, Oct 13 8 AM - 12 PM'`
(`formatDay(row.date)`, a space, then `formatTime(row.startsAt) - formatTime(row.endsAt)` with a
plain hyphen). The rows hold local wall-clock times (`'08:00:00'`), so `formatTime` fits.
`formatWindow`'s en dash would switch the text to Unicode. The list is read once per contractor
per run, and only when it has a lead to text.

New `online-booking/recovery-texts.ts`, plain ASCII like `waitlist-texts.ts`:

```ts
export function abandonedBookingText(t: { tenantName: string; windows: string[]; link: string })
// "Acme HVAC: you started booking a visit. Open times: Tue, Oct 13 8 AM - 12 PM; Tue, Oct 13
//  12 PM - 4 PM; Wed, Oct 14 8 AM - 12 PM. Finish here: <link> Reply STOP to opt out."

export function missedCallerReminderText(t: { tenantName: string; windows: string[]; link: string })
// "Acme HVAC: still need a visit? Sorry we missed your call. Open times: <...>. Book here: <link>
//  Reply STOP to opt out."
```

With no open windows, the `Open times: ….` sentence is left out. With one or two, only those are
listed. The windows are joined with `'; '`.

### 1. Abandoned-booking text (changed)

`sendRecoveryTexts()` keeps its name and transaction shape: per draft, `sendText(kind
'abandoned_booking')` and `markDraftTexted` in one transaction. Changes:

- It loops over due contractors (as above) and passes each one's `morning` to the query.
- `listDraftsToRecover(tenantId, { since: morning − 24h, before: min(morning, now − 60 min) })`
  keeps every current condition (consent, not booked, not texted, no job for the phone since the
  draft began) and adds `safety_stopped_at is null`.
- The body comes from `abandonedBookingText`.

### 2. Missed-caller reminder (new)

New `sendMissedCallerReminders()` in `calls/calls.service.ts`, run by the same job after the
drafts. For each due contractor, `calls.queries.listCallersToRemind(tenantId, { since, before })`
returns one row per phone: the latest missed call (`answered_by is null`, `from_phone` not null)
whose `started_at` falls in the range, when all of these hold:

1. **Consent:** the phone's latest `consent_events` row for channel `sms` has `granted = true`.
   Filtered in the query so callers without consent don't fill the messages table with `blocked`
   rows. `sendText()` still checks it.
2. **Not booked:** no job for that phone (through `customers.phone`) created after the call.
3. **Not started online:** no `booking_drafts` row for that phone created after the call. That
   draft gets its own text.
4. **Not already talking:** no answered call (`answered_by` not null) and no inbound text
   (`messages.direction = 'inbound'`, `contact` = phone) after the call.
5. **Not reminded lately:** no `missed_caller_reminder` message to that phone in the last 7 days
   (`REMINDER_GAP_DAYS`), whatever its status.

Per row, in one transaction: `sendText(kind 'missed_caller_reminder', callId: <latest call>,
customerId: call.customerId)`, with the body from `missedCallerReminderText` and the link
`/?call=<id>&phone=<phone>` (the text-back link), so a booking from it is saved as `text_back`
and counts as recovered. That message row is the record that the reminder went out, so no new
column is needed. Condition 5 is what stops a second one.

### 3. Safety stop

API:

- New column `booking_drafts.safety_stopped_at timestamptz` (null = not stopped), with a drizzle
  migration.
- New route `POST /online-booking/drafts/:token/safety-stop` (`draftLimit`, `tenantFromHost`),
  calling `onlineBooking.stopDraftForSafety(tenantId, token)`. It sets `safety_stopped_at = now()`
  on an open draft and answers `{ ok: true }`. An unknown or booked draft is a 404 with
  `DRAFT_GONE`, like the other draft routes. It doesn't count as homeowner activity
  (`last_activity_at` unchanged). It writes an audit row `booking_draft.safety_stopped`.
- `saveDraftAnswers()` clears `safety_stopped_at` when the saved answers include a `problem`. Only
  a homeowner who answered "No, we're safe" and finished step 4 sends one.
- The recovery index `booking_drafts_recovery_idx` stays as it is. The extra condition is cheap
  on the rows it already narrows to.

Web (`relay-web`):

- New `stopDraftForSafety(token)` in `features/booking/api.ts`.
- `SafetyStop` takes `draftToken` and calls it once when it shows (a `useEffect` on mount). A
  failure is ignored: the safety message must show whatever happens.
- "I tapped Yes by mistake" is unchanged. Carrying on to the end of step 4 clears the stop
  through the answers save.

### Jobs

`booking-recovery` (every 5 minutes) calls `sendRecoveryTexts()` then
`sendMissedCallerReminders()` and logs both counts when either is above 0.

## Errors and edge cases

- A contractor in quiet hours is skipped this run. Its leads are picked up on a run after the
  morning, still inside the range.
- A homeowner active again after the morning moves `last_activity_at` past `morning`, so the
  draft leaves today's range. It becomes due the next morning, if it is still unbooked.
- A homeowner who opted out (STOP) is blocked by `sendText()`. The draft is still marked texted,
  as today, so it isn't tried again.
- A failure in one draft's or call's transaction rolls back only that one, then the job fails and
  pg-boss retries. Leads already done aren't texted twice: they are marked (draft) or have their
  message row (call).
- A missed caller who calls several times gets one reminder, about the latest call in the range.

## Testing

TDD, against the test database, as in the existing `*.test.ts` files.

- `lastMorning`: before, after and exactly at `end`; a timezone ahead of UTC and one behind; an
  `end` other than 08:00.
- `recovery-texts.ts`: three, one and no windows; ASCII only.
- `sendRecoveryTexts`: texted when quiet since before the morning; not texted when the activity
  is after the morning, older than the previous morning, less than 60 minutes ago, safety-stopped,
  booked, or without consent; not texted while the contractor is in quiet hours; the text lists
  the open windows.
- `sendMissedCallerReminders`: one text for a due caller with consent, with the call link and
  `callId`; none without consent; none when they booked, started a draft, called back and were
  answered, or texted in; none within 7 days of an earlier reminder; one text for two missed calls
  from one phone.
- The safety-stop route: sets the column; 404 for an unknown or booked draft; a later answers
  save with a problem clears it.
- Web: relay-web has no component-test setup (Vitest runs in `node`), so `SafetyStop` is checked
  by typecheck, lint and by hand in the browser: answering "Yes" sends one
  `POST …/safety-stop`.

## Delivery

Branch `feat/lead-recovery` in `relay-api` and in `relay-web`, one PR each. The relay-web PR
depends on the API route.
