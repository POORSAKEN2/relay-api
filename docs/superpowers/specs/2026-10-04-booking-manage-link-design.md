# Booking manage link: the homeowner reschedules or cancels from a link

Date: 2026-10-04. Status: approved. Plan: `docs/superpowers/plans/2026-10-04-booking-manage-link.md`.
Builds on: `2026-10-04-booking-confirmation-design.md` (the confirmation text and email carry
the link).

## Problem

A homeowner who booked online and can't make it has to phone the office. `jobs.manage_link_hash`
was planned for this ("homeowner reschedule / cancel") and is already cleared when a job closes
(`jobs_closed_links_cleared`), but nothing sets it, and there is no API or page behind it.

## Goal

1. Every online booking gets a private link, sent in the confirmation text and email.
2. The link opens a page showing the visit, where the homeowner can **change the time** to
   another open arrival window or **cancel** the visit.
3. Both are allowed only while the job is `booked` and its window hasn't started. After that the
   page says to call the contractor.
4. The homeowner gets a text (and an email when they have one) saying what changed; an assigned
   technician gets a text; the office sees the change live on the dispatch board.

## Out of scope

- Offering the freed place to the waitlist: feature 3 (waitlist offer) hooks into the cancel
  and the move built here.
- Links for jobs the office books (they get no confirmation today).
- A cancel reason, changing the service, the address or the contact details.
- A text to the technician when the **office** cancels a job (only homeowner cancels text them
  here).
- Reschedule after a `no_access` visit: only `booked` jobs can be changed online.

## The link

`src/lib/link-token.ts`, pure:

```ts
newLinkToken(): { token: string; hash: string } // 18 random bytes, base64url (24 characters)
hashLinkToken(token: string): string            // sha256, hex
```

- 18 bytes (144 bits) is far beyond guessing, and keeps the text short. Only the hash is stored,
  as for sessions: someone who reads the database can't use the links.
- `bookVisit()` creates one and saves `manageLinkHash` with the job (in `insertBookedJob`'s
  values).
- The link is `tenantUrl(tenant, '/manage/<token>')`, e.g.
  `https://desert.garified.com/manage/Xk3…`. Same known gap as the recovery link: on a local
  demo, the phone needs the web app on a public address.

### In the confirmation (feature 1)

`Confirmation` gains `manageUrl: string`.

- Text: ` Change or cancel: <url>` is added before ` Reply STOP to opt out.`:
  `Desert Breeze Air: you're booked for AC Repair on Tue, Oct 6, 8 AM - 12 PM at 123 Main St.
  Pay at the visit. Change or cancel: https://desert.garified.com/manage/Xk3… Reply STOP to opt
  out.` This makes it 2 SMS parts.
- Email: a line `Need to change or cancel? <url>` after the "nothing to pay now" line.

## API

New files `src/modules/online-booking/manage.service.ts` and `manage.queries.ts` (the lookup).
The routes go in `online-booking.routes.ts` and `RescheduleInput` in `online-booking.schemas.ts`,
beside the booking page's, sharing their rate limiter. Public like the booking page:
`tenantFromHost`, no sign-in, the same `formLimit` (60 tries per 15 minutes per address).

Every route finds the job by `(tenant from the host, hashLinkToken(token))`. No job → `404
not_found` "This link doesn’t work anymore. Call <phone> to make changes." The phone is the
tenant's `contactPhone`, formatted. A cancelled or done job has no hash, so its link is a 404.

### `GET /api/online-booking/manage/:token`

```json
{
  "status": "booked",
  "serviceName": "AC Repair",
  "date": "2030-01-08",
  "dayLabel": "Tue, Jan 8",
  "windowLabel": "8 AM–12 PM",
  "address": "4 Cactus Rd, Mesa, AZ 85201",
  "canChange": true,
  "contactPhone": "(480) 555-0100"
}
```

`canChange` = status is `booked` and `window_starts_at > now()`. `windowLabel` uses the screen
format (`formatWindow`, en dash): this is a page, not a text.

### `POST /api/online-booking/manage/:token/reschedule`

Body `{ date, windowId }` (same fields and messages as the booking form's).

In one transaction:

1. Lock the job (`lockJob` from dispatch queries) and check the rule: `booked` and not started,
   else `409 cannot_change` "Your visit can’t be changed online anymore. Call <phone>."
2. Same day and window as now → nothing changes, `200`.
3. `reserveWindow(tx, tenantId, windowId, date, { allowOverCap: false, excludeJobId })`, then
   refuse a window that already started; the same messages as booking (`window_full`
   "That arrival window just filled up. Pick another one.", `window_started`). The existing
   `reserveOpenWindow()` in `online-booking.service.ts` gains an `excludeJobId` option and is
   exported for this.
4. Update the job: the new `windowStartsAt` / `windowEndsAt`, `etaAt = null`. The technician
   stays assigned.
5. Audit: homeowner action `job.moved`, data `{ from: { date, windowId }, to: { date, windowId } }`.
6. Texts (below).

After the commit: `emitToTenant(tenantId, 'job.assigned', { jobId, dates: [old, new] })`, the
event the board already reloads on for an office move.

Answer: the same shape as `GET`, for the new time.

### `POST /api/online-booking/manage/:token/cancel`

No body. Uses `changeStatus()` from `dispatch.service.ts`, the only place status rules live, so
the job is cancelled exactly like an office cancel (status, `etaAt` cleared, both link hashes
cleared, `job.status_changed` event):

- `checkJob` applies the online rule (`booked` and not started), else the `409` above.
- `changeStatus` today takes `actorUserId: string`. It becomes
  `actor: { userId: string } | 'homeowner'`; a homeowner's change is audited with
  `audit.insertHomeownerAction` (same action `job.status_changed`). Its callers today
  (`setStatus` in dispatch, the technician's status buttons in technician-jobs) pass
  `{ userId }`.
- `afterChange` sends the texts (below).
- Cancelling an already cancelled job can't happen through the link (its hash is gone, so 404).

Answer: `{ "status": "cancelled" }`.

## Who is told

All saved in the change's transaction, so a refused change sends nothing.

### The homeowner

Kind `booking_changed` (rule `VISIT`: consent required, sent at once). The phone is the job's
customer's. Plain characters only (`plainText`, `textWindow`).

- Moved: `Desert Breeze Air: your visit is moved to Wed, Jan 9, 12 PM - 4 PM. Change or cancel:
  <url>` — the same link, still valid.
- Cancelled: `Desert Breeze Air: your visit on Tue, Jan 8 is cancelled. Book again:
  <booking page url>`

When the customer has an email (`customers.email`), the same news by email, kind
`booking_changed`:

- Subject `Your visit is moved to Wed, Jan 9` / `Your visit on Tue, Jan 8 is cancelled`.
- Body: greeting, the sentence above, the new window and address (moved), the contractor's
  phone, the link to change again (moved) or book again (cancelled), the contractor's name.

The words live beside the confirmation's, in `confirmation.ts`: `changedText`, `changedEmail`,
`cancelledText`, `cancelledEmail`.

### The technician

Only when one is assigned. `textTechnician()` moves from `dispatch.service.ts` to
`src/modules/dispatch/technician-texts.ts` (exported, same behaviour), and gains
`'cancelled'`:

- Moved: the existing `Job changed` text (kind `job_assigned`).
- Cancelled: `<contractor>: Job cancelled. <service> in <city>, <day>, <window>.` No link: the
  job page is gone from their list.

### The office

No text. The board reloads on `job.assigned` / `job.status_changed`, and the audit log names the
homeowner as the actor.

## Web: `relay-web`, route `/manage/:token`

Public (no `RequireRole`), inside `AppLayout`, using `BookingShell` and the booking page's
`Panel` look. Files in `src/features/manage-booking/`: `api.ts` (queries and mutations,
`X-Tenant-Host` like the booking API), `manage-page.tsx`, and the route `src/routes/manage.tsx`.

States:

| State | Shows |
| --- | --- |
| Loading | A skeleton panel. |
| `404` | "This link doesn't work anymore" with the message's phone as a `tel:` link. |
| `canChange` | The visit summary (service, day and window, address) and two buttons: **Change time**, **Cancel visit**. |
| Not `canChange` | The summary and "Your visit can't be changed online anymore. Call (480) 555-0100." |
| Changing time | The booking wizard's day calendar and windows (`BookingCalendar`, `useOpenWindows`), **Confirm new time** and **Back**. On success: the summary with a "Your visit is moved" notice. |
| Cancel confirm | A dialog: "Cancel your visit on Tue, Jan 8?" with **Cancel visit** and **Keep visit**. On success: "Your visit is cancelled" and a **Book another visit** link to `/`. |
| `409` from either action | The API's message in a toast, then reload the visit (it may be locked now, or the window full). |

The calendar part of `TimeStep` (calendar plus the chosen day's windows) is pulled out into a
`WindowPicker` component that both `TimeStep` and the manage page use, so the two never drift.

## Data

No migration: `jobs.manage_link_hash` (unique) and the `jobs_closed_links_cleared` check
already exist.

## Tests

API:

- `link-token.test.ts`: tokens are 24 URL-safe characters and differ; the hash is the sha256.
- `online-booking.test.ts`: a booking saves a hash, and its text and email carry a link whose
  token hashes to it.
- `confirmation.test.ts`: the link in the confirmation; the changed and cancelled words, plain.
- `manage.test.ts` (supertest):
  - `GET` shows the visit; `canChange` false once the window started or the job is en route.
  - A wrong token and another contractor's host → 404.
  - Reschedule moves the job, keeps the technician, clears `etaAt`, audits, emits, texts the
    homeowner and the technician; same slot → nothing; full window → 409; started window → 422;
    locked job → 409 and nothing saved.
  - Cancel cancels, clears both hashes (the link is then 404), audits as homeowner, emits,
    texts the homeowner and the technician; locked job → 409.
  - A homeowner with an email also gets the email; without consent the text is `blocked`.
- `dispatch.test.ts` and `job-actions.test.ts`: office and technician status changes still audit the user (the `actor` change).

Web: `relay-web` tests plain functions only (no component tests), so the page's choice of
state is a pure `manageView(query)` in `src/features/manage-booking/view.ts`, tested for every
row of the states table. The page itself is checked by hand in the browser: open a link,
change the time, cancel, open the link again.

## Build order

1. `link-token.ts`; `bookVisit()` saves the hash; the link in the confirmation.
2. `textTechnician` moved and `'cancelled'`; `changeStatus` actor; the changed/cancelled words.
3. Manage API: get, reschedule, cancel.
4. Web: `WindowPicker`, the manage page and route.
