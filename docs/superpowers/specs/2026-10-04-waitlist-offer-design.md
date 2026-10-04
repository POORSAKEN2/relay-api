# Waitlist offer: text the next homeowner in line when a place opens

Date: 2026-10-04. Status: draft, waiting for review.
Builds on: `2026-10-04-booking-confirmation-design.md` (the booking an offer ends in sends the
usual confirmation) and `2026-10-04-sms-service-design.md` (`sendText`, consent, quiet hours).

## Problem

On the time step, a homeowner who finds no window that works can join the waitlist
(`POST /online-booking/waitlist`). That saves a `waitlist_entries` row (`waiting`) and an `sms`
consent row, but nothing ever reads the waitlist again: when a place opens, nobody is told.

## Goal

1. When an arrival window has a free place, the next homeowner in line gets a text with a link
   that books that place.
2. The place is held for them for **30 minutes**: nobody else can book it, and the calendar
   doesn't show it. Then it goes to the next homeowner in line.
3. The line is **priority first** (`priority`, set when a vulnerable occupant was ticked), then
   **whoever joined first**.
4. An offer that runs out keeps the homeowner's place in line. After **2** run out, they are
   taken off the waitlist with one last text. Everyone is also taken off after **14 days**, when
   they book any visit, or when they text STOP.
5. No offers are made during the contractor's quiet hours.

Done means: a freed place is booked by a homeowner who was waiting, nobody is texted about a
place that is already gone or twice for the same place, and nobody is texted after STOP.

## Out of scope

- An office waitlist screen (list, remove, offer by hand). Offers show in the message log only.
- Preferred days or times on an entry: any open place in the next 14 days is offered.
- Places tied to a service: windows aren't per service today.
- Replying "YES" by text to book.
- Hooks in cancel / move / window settings: the minute job finds every opening (see below).

## How an opening is found

A pg-boss job, `waitlist-offers`, runs every minute (`'* * * * *'`, in `src/jobs/index.ts`, like
`booking-recovery`). It works out openings from the current state, so every way a place opens is
covered with no hooks: a homeowner cancel or move (manage page), an office cancel or move, a
higher `job_cap`, a new window, an expired hold. A place is found within a minute, which is
small next to a 30-minute offer.

## Data

Migration `0014_waitlist_offers.sql`. On `waitlist_entries`:

| Column | Type | Meaning |
| --- | --- | --- |
| `ends_at` | `timestamptz not null` | When the entry is taken off: joined (or joined again) + 14 days. Backfilled as `created_at + 14 days`. |
| `offer_window_id` | `uuid` | The window offered (FK `(tenant_id, offer_window_id)` → `arrival_windows`) |
| `offer_date` | `date` | The day offered |
| `offer_window_starts_at` | `timestamptz` | Start of the offered place, matched against `jobs.window_starts_at` when counting |
| `offer_expires_at` | `timestamptz` | Offer time + 30 minutes |
| `offer_link_hash` | `text unique` | sha256 of the link token (`newLinkToken()`), as for the manage link |
| `offers_missed` | `smallint not null default 0` | Offers that ran out: 0, 1 or 2 |

- `WAITLIST_STATUSES` gains `expired`: `waiting`, `offered`, `booked`, `removed`, `expired`.
  `removed` = texted STOP; `expired` = 14 days or 2 missed offers.
- Check `waitlist_entries_offer_complete`: `status = 'offered'` if and only if all five
  `offer_*` columns are set.
- Index `waitlist_entries_offered_idx` on `(tenant_id, offer_window_starts_at)` where
  `status = 'offered'`, for the counts below.

`ends_at` is the only column not shown in the design talk: it lets joining again restart the
14 days without moving the homeowner's place in line (`created_at` stays).

## The hold

An open offer takes a place in its window. "Open" means `status = 'offered'` and
`offer_expires_at > now()`, so an offer that just ran out frees its place at once, before the
job's next run tidies it.

Two counts add open offers to the window's active jobs:

- `countActiveJobsAt` (`booking.queries.ts`), used by `reserveWindow` for every booking: online,
  office, reschedule. It gains `excludeOfferId`, beside `excludeJobId`, so the homeowner holding
  the offer doesn't count against themselves.
- `listOpenWindows` (`online-booking.queries.ts`), the booking calendar. It gains an optional
  `offerId` with the same meaning, used by the offer link's calendar.

`allowOverCap` (the office overbooking on purpose) is unchanged.

## The job: `sendWaitlistOffers()`

In `src/modules/online-booking/waitlist.service.ts`, queries in `waitlist.queries.ts`. For each
`live` tenant with `waiting` or `offered` entries, in this order. Each numbered step is its own
transaction per entry, so a failure leaves nothing half done (an offer always has its text).

1. **Close finished entries** (`waiting` or `offered`):
   - `ends_at <= now()` → `expired`, no text.
   - The customer has a job not `cancelled` / `expired` with `booked_at > created_at` → `booked`.
   - The newest `sms` consent row for the customer's phone has `granted = false` → `removed`.
   Offer columns are cleared in each case.
2. **Offers that ran out** (`offered`, `offer_expires_at <= now()`): clear the offer columns,
   `offers_missed + 1`.
   - Now 1 → `waiting` (same `created_at`, so same place in line).
   - Now 2 → `expired`, and the taken-off text.
3. **New offers**, skipped while `quietUntil(now, …)` says it is quiet hours:
   - The open places: `listOpenWindows` for 14 days, keeping places whose start is at least
     **2 hours** from now. A window with 2 free places counts twice.
   - For each place, soonest first, the next `waiting` entry
     (`order by priority desc, created_at`), locked with `for update skip locked`.
   - In one transaction: `lockWindow` (as `reserveWindow` does, so a booking at that instant
     waits its turn), recount the place with offers; if it filled, skip it. Otherwise set the
     entry `offered` with its offer columns, and `sendText` the offer.
   - Stops when either the places or the waiting entries run out.
4. Returns `{ offered, expired }`; the job logs them when non-zero, like the other jobs.

Rules from `sendText` still apply on top: a text blocked by consent is saved as `blocked`. The
entry is closed as `removed` on the next run (step 1).

## The texts

Both kind `waitlist_offer` (unprompted: consent required, quiet hours respected). Built by pure
functions in `waitlist-texts.ts`, tested alone.

- Offer: `Desert Breeze Air: a time opened up: Tue, Oct 7, 8–11 AM. It's yours for 30 minutes:
  https://desert.garified.com/?offer=Xk3… Reply STOP to opt out.`
- Taken off: `Desert Breeze Air: we've taken you off the waitlist. Book anytime:
  https://desert.garified.com/ Reply STOP to opt out.`

The day uses `formatDay`, the window `textWindow`, the link `tenantUrl` (same local-demo gap as
the recovery and manage links).

## Joining again

`joinWaitlist`: if the customer (found by `findOrAddCustomer`) already has a `waiting` or
`offered` entry for the same service, it is updated (`zip`, `priority`, `ends_at = now + 14
days`) instead of adding one. `created_at`, and so the place in line, stays. An open offer
stays open. The consent row is still written.

## API

### `GET /api/online-booking/offers/:token`

`tenantFromHost`, like the manage link: a token only works on its own contractor's address.

- 200: `{ serviceId, zip, name, phone, vulnerableOccupant, date, windowId, dayLabel,
  windowLabel, heldUntilLabel }`. `heldUntilLabel` is e.g. `3:42 PM`, in the contractor's
  timezone. `vulnerableOccupant` comes from `priority`.
- 404 `not_found`: unknown token, an offer that ran out or was used, or another contractor's:
  `This offer has ended. Pick another time, or call (480) 555-0100.`

### `GET /api/online-booking/windows?offer=<token>`

The calendar for the offer link: the held place shows as open for its holder only. An ended or
unknown token is ignored (the usual calendar).

### `POST /api/online-booking/bookings`

`BookingInput` gains `offerToken: string` (optional).

- An open offer for this tenant: `reserveOpenWindow` gets `excludeOfferId`, so the held place
  doesn't count against it. In the same transaction the entry becomes `booked` with its offer
  columns cleared. This holds whether or not the homeowner books the offered place.
- An offer that ran out or is unknown: ignored. The booking goes through when the window has a
  free place, or gets the usual `window_full`.
- The confirmation from feature 1 goes out as for any booking.

## Web: `relay-web`

- `/?offer=<token>`, read once like `?resume=`. While `GET offers/:token` loads, the wizard waits.
- Found: answers start with `serviceId`, `zip`, `name`, `phone`, `vulnerableOccupant`, and the
  offered `date` / `windowId` / `timeLabel`. The wizard opens at **problem** (`resolveStep`
  already sends a homeowner to the first unanswered step). Back still reaches the earlier steps.
- Time step: the offered window is picked, with the note `Held for you until 3:42 PM`. The
  calendar comes from `windows?offer=`. Other open windows can be picked; they aren't held.
- Details step: `offerToken` is sent with the booking.
- Ended: a banner `This offer has ended. Pick another time below.` and the wizard starts as usual.
- An offer link wins over a saved draft in this browser.

## Errors

- A failing job run goes to Sentry and is retried by pg-boss (`reportFailures`), like the others.
- Two runs at once (a slow run overlapping the next): `skip locked` on entries and the window
  lock keep them from offering the same place or the same homeowner twice.
- A STOP between the offer and the booking doesn't block the booking; the confirmation text is
  then `blocked` by consent, as today.

## Tests

API (`waitlist.test.ts`, test database, `sendWaitlistOffers()` called directly; `now` faked with
`vi.useFakeTimers` where needed):

- Order: priority before older, older before newer; one offer per free place; a window with 2
  free places makes 2 offers; no place starting within 2 hours; nothing in quiet hours; a
  `suspended` tenant gets nothing.
- Hold: an open offer hides the place from `GET windows` and makes `POST bookings` return
  `window_full` for others; the holder books it with `offerToken`; `windows?offer=` shows it to
  the holder; the office's `allowOverCap` still books; an offer past `offer_expires_at` no longer
  holds.
- Running out: 1 miss → `waiting` with the same place in line; 2 → `expired` with the taken-off
  text; `ends_at` → `expired`; STOP → `removed`; a booking elsewhere → `booked`.
- The offer text: kind, body, link token matches `offer_link_hash`.
- Joining again: one entry; `created_at` kept; `ends_at` moved.
- Race: the job offering the last place while a booking takes it → exactly one wins, no overbook.
- `GET offers/:token`: 200 shape; 404 ran out, used, other contractor's host.
- `waitlist-texts.ts`: both bodies, pure.

Web (vitest):

- An offer link fills the answers and opens at the problem step.
- An ended link shows the banner and starts at the service step.
- The booking sends `offerToken`.

## Build order

1. Migration, schema, status `expired`.
2. The hold in both counts, with `excludeOfferId` / `offerId`.
3. `waitlist-texts.ts`.
4. `sendWaitlistOffers()` and the `waitlist-offers` job.
5. Joining again.
6. `GET offers/:token`, `windows?offer=`, `offerToken` on bookings.
7. Web: offer link, time-step note, banner.
8. Browser check with the user.
