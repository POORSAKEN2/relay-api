# Office alerts: new-booking and priority-job texts

Date: 2026-10-05. Status: draft. Plan: `docs/superpowers/plans/2026-10-05-office-alerts.md`.
Depends on: the SMS service (`2026-10-04-sms-service-design.md`), already built.

## Problem

MVP modules 6 and 10 promise the office a text when a booking comes in, and a text right away
when a priority job comes in. `MESSAGE_KINDS` already has `new_booking_alert` and
`priority_alert`, and `rules.ts` already places both under `STAFF`, but nothing sends them.
Today the office only sees a new or priority job if the dispatch board is open
(`booking.created` / `booking.priority` socket events).

Two gaps stand in the way:

1. Owner and office users can't enter a phone. `users.phone` exists, but `StaffInput`
   (`src/modules/team/staff.schemas.ts`) only takes name, email and role, so only technicians
   ever have one.
2. There is no code that finds who to alert or writes the alert.

## Goal

1. Every booking, however it was made, texts the contractor's office staff once.
2. A priority job texts them at any hour. An ordinary booking made at night waits until quiet
   hours end, so nobody's phone buzzes at 2 AM for a Tuesday tune-up.
3. Owner and office users can add, change and clear their mobile number on the Staff screen.
   Adding a number is how someone opts in to alerts.
4. No schema change.

## Out of scope

- Email alerts. Module 10 says "SMS and email"; this task is texts only. Easy to add later with
  `queueEmail()` beside `sendText()`.
- A separate on/off switch per person or per kind. A phone on the user record means "alert me";
  no phone means no alerts.
- Alerts when a job becomes priority later. Nothing changes `jobs.priority` after booking today.
- Alerts for cancellations, moves, or waitlist entries.
- A person who is both owner and technician. `users.phone` is unique across Relay, so they can't
  put the same number on two accounts. Rare for the pilot; revisit if a pilot asks.

## Decisions

### Who gets the alert

Every **active** (`disabled_at is null`) user of the contractor with role `owner` or `office`
and a phone, **except the person who booked the job** (`jobs.created_by`). They know already.

"Office manager" is not a role in Relay (`USER_ROLES` is owner, office, technician,
superadmin), and small shops often have the owner answering the phone. Using the phone on the
record as the opt-in keeps one rule, with no new column and no settings screen.

### One text per booking

A priority booking sends **one** `priority_alert`, not a `new_booking_alert` and a
`priority_alert`. Two texts about the same job is noise and twice the cost.

```
kind = job.priority ? 'priority_alert' : 'new_booking_alert'
```

### When it goes

`rules.ts` is the one place that decides consent and quiet hours. It changes like this:

| Kind | Consent | Quiet hours | Why |
|---|---|---|---|
| `priority_alert` | none | no | someone vulnerable may have no heat or cooling: wake them |
| `new_booking_alert` | none | **yes** (new) | routine; held until `quiet_hours_end` like other unprompted texts |

A new rule constant, `STAFF_ROUTINE = { consent: 'none', quietHours: true }`, sits beside
`STAFF`. `sendText()` already sets `send_after` from the rule, so `sms.ts` needs no change.

### Where it hooks in

`insertBookedJob()` in `src/modules/booking/booking.service.ts` is the one function every
booking goes through (office, online, and later the AI receptionist and text-back). It calls
`sendOfficeAlert(tenantId, job.id, tx)` after the booked lines are written.

Same transaction as the booking: a booking that rolls back never alerts, and a saved booking
always has its alert rows. `sendText()` makes no network call, so the transaction stays short.

### What the text says

Plain GSM-7 characters only (`'` and `-`, never `’` or `–`), so one SMS holds 160 characters.
No homeowner name, phone or street: texts pass through carriers and phones that may be shared.
The city, service and time are enough to decide whether to open the link.

```
Desert Breeze Air: New booking (online). AC repair in Phoenix, Tue Jan 8, 8-10 AM. https://<contractor address>/dashboard?date=2030-01-08&job=<id>

Desert Breeze Air: PRIORITY job (online). Vulnerable person, no heat or cooling. AC repair in Phoenix, Tue Jan 8, 8-10 AM. https://<contractor address>/dashboard?date=2030-01-08&job=<id>
```

- Source label, from `jobs.source`: `web` online, `office` by the office, `ai` by the AI
  receptionist, `text_back` from a text-back, `recovery_text` from a recovery text. A
  `Record<JobSource, string>` so TypeScript refuses a new source until it has a label.
- Priority reason: `Vulnerable person, no heat or cooling.` when `vulnerable_occupant`, else
  `Priority service requested.` (the homeowner paid the priority fee).
- Link: `tenantUrl(tenant, '/dashboard?date=…&job=…')`. The dashboard already opens the job's
  drawer from `?job=` (`relay-web/src/routes/dashboard.tsx`). A signed-out user goes through
  sign-in first.

With the link the text is about 2 SMS segments. Accepted: the link is the point of the text.

### Phone on the Staff screen

- `src/lib/fields.ts`: new `OptionalPhone`. An empty string becomes `null`, so saving an empty
  field clears the number (unlike `OptionalEmail`, which turns it into `undefined`).
- `StaffInput` gains `phone: OptionalPhone`. `insertStaff` / `updateStaff` save it;
  `selectStaff` returns it.
- A taken number already maps to `409 phone_taken` through `saveOrExplain()`.
- Phone sign-in stays technician-only (`findTechnicianByPhone` filters on role), so an office
  phone can't be used to sign in by text.
- relay-web staff dialog: optional "Mobile phone" field with the hint
  `For booking alerts by text. Leave empty for none.` The staff list shows the number.

## Module layout

```
booking.service.ts ── insertBookedJob() ──► office-alerts.service.ts ──► messaging/sms.ts
                                              │                            (sendText)
                                              ├─► office-alerts.queries.ts
                                              └─► office-alerts/wording.ts (pure)
```

- `src/modules/office-alerts/office-alerts.queries.ts`
  - `findAlertJob(tenantId, jobId, tx)`: contractor name and URL parts, service name, city,
    local date and window, source, priority, vulnerable occupant, created by.
  - `listAlertRecipients(tenantId, exceptUserId, tx)`: `{ id, phone }` of active owner and office
    users with a phone, minus `exceptUserId`.
- `src/modules/office-alerts/wording.ts`: `officeAlertText(job, link)` returns the body. Pure, so
  it is unit-tested without a database.
- `src/modules/office-alerts/office-alerts.service.ts`: `sendOfficeAlert(tenantId, jobId, tx)`
  loads the job and recipients, builds the body once, and calls `sendText()` per recipient with
  `toUserId` and `jobId`.

Dependencies point one way: booking → office-alerts → messaging. Office-alerts never imports
booking. It reuses `local()` from `dispatch.queries.ts`, as `homeowner-messages` already does.

## Edge cases

| Case | Result |
|---|---|
| No owner or office user has a phone | no rows; booking unaffected |
| Booker is the only one with a phone | no rows |
| Disabled user with a phone | skipped |
| Contractor has no active sending number | row saved, sender marks it `failed` (existing behavior) |
| Online booking at 23:00, ordinary | `new_booking_alert` with `send_after` = quiet hours end |
| Online booking at 23:00, priority | `priority_alert`, sent within about 5 seconds |
| Booking rolls back (window full, etc.) | no alert rows |

## Testing

- `rules.test.ts`: `new_booking_alert` waits for quiet hours, `priority_alert` doesn't.
- `wording.test.ts`: both bodies; every source has a label; no `’` or `–`.
- `fields.test.ts`: `OptionalPhone` turns `''` into `null` and normalises a number.
- `office-alerts.test.ts` (database): office booking alerts other staff but not the booker;
  online booking alerts all staff with a phone; disabled, phoneless, technician and
  other-contractor users get nothing; priority booking writes one `priority_alert` and no
  `new_booking_alert`; quiet-hours timing for both kinds.
- `staff.test.ts`: phone saved, cleared with `''`, `phone_taken` on a duplicate.
- relay-web: staff dialog sends the phone and shows `phone_taken` on the field.
