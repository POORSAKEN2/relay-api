# Recovery analytics API

Date: 2026-10-06. Status: built. Plan: `docs/superpowers/plans/2026-10-06-recovery-analytics.md`.
Depends on: nothing new. Reads tables that already exist.

## Problem

The task: build `GET /api/analytics/recovery` that returns, for a date range:

- total missed calls (`calls.answered_by IS NULL`);
- how many were handled by text-back and how many by the AI;
- jobs booked from recovery (`jobs.source IN ('text_back', 'ai', 'recovery_text')`);
- revenue from those jobs (sum of paid invoice totals).

This is the API half of MVP module 11, the recovered-revenue dashboard ("Owner, web, readable on
a phone: missed calls, and how many the AI or text-back handled; jobs booked from recovery;
revenue from those jobs"). The pilot success test ("each shop recovers 20+ jobs a month") is read
from it.

What already exists:

- `calls`, written by the httpSMS `message.call.missed` webhook (`webhooks.service.ts →
  recordMissedCall`). `answered_by` is `null` (missed), `'office'` or `'ai'`.
- `messages.call_id`: "the call a text-back answers". `kind = 'text_back'`.
- `RECOVERED_JOB_SOURCES` in `schema.ts`, and `countRecoveredJobs()` in `billing.queries.ts`,
  which counts recovered jobs for the per-job fee: booked in the period (contractor's local
  dates), not cancelled.
- `invoices` (homeowner invoices): one per job, `status` `open | paid | void`, `total_cents`.
- `LocalDate` in `src/lib/fields.ts`, `findTimezone()` in `dispatch.queries.ts`, `tenantOf()`.

What is not built yet (the numbers will read 0 until it is, and that is correct):

- The text-back sender. Nothing writes a `text_back` message with `call_id` yet.
- The AI receptionist. `voice` is a setup stub; nothing writes `answered_by = 'ai'` yet.
- Homeowner invoicing. Nothing inserts into `invoices` yet (payments are recorded by hand,
  decided 2026-10-03).

## Goal

1. One owner-only endpoint returns the five numbers for a range of the contractor's local dates.
2. "Jobs booked from recovery" is the same rule billing uses for the per-job fee, written once,
   so the dashboard and the monthly fee can never disagree.
3. No schema change, no new dependency, no `relay-web` change.

## Out of scope

- The dashboard screen in `relay-web`. Separate task; it calls this endpoint.
- Charts over time (per day / per week). One total per range for now.
- `missed_caller_reminder` texts. The task names text-back only.
- Revenue from job items when no invoice exists. The MVP scope's open question ("paid invoices
  only, or job value entered by the office?") is answered by the task: paid invoices only.
- An index on `messages.call_id`. Pilot volume is small (see Performance).
- Seeding demo calls and invoices. Can be its own small task once text-back exists.

## API

```
GET /api/analytics/recovery?from=2026-10-01&to=2026-10-31
```

- Signed-in **owner** only (`requireRole('owner')`). Office gets 403, signed out 401. Same as
  `/api/billing`: the MVP scope lists the dashboard under "Owner", and it shows revenue.
- `from`, `to`: required local dates (`LocalDate`), **both inclusive**, in the contractor's
  `tenants.timezone`. `to` before `from` is a 400 (`validation_failed`, path `to`).

Response `200`:

```json
{
  "from": "2026-10-01",
  "to": "2026-10-31",
  "missedCalls": 14,
  "handledByTextBack": 9,
  "handledByAi": 6,
  "jobsBooked": 5,
  "revenueCents": 184500
}
```

Money is integer cents, like every other money field.

## Definitions

All counts are for the signed-in owner's contractor only.

| Field | Rule |
|---|---|
| `missedCalls` | `calls` with `answered_by IS NULL` and `started_at` in the range |
| `handledByTextBack` | of those missed calls, the ones with at least one `messages` row: `call_id` = the call, `kind = 'text_back'`, `status IN ('sent', 'delivered')` |
| `handledByAi` | `calls` with `answered_by = 'ai'` and `started_at` in the range |
| `jobsBooked` | `jobs` with `source IN RECOVERED_JOB_SOURCES`, `status <> 'cancelled'`, `booked_at` in the range (the billing rule) |
| `revenueCents` | sum of `invoices.total_cents` with `status = 'paid'`, for the jobs counted in `jobsBooked`; 0 if none |

"In the range" = from the start of `from` up to (not including) the start of the day after `to`,
both in the contractor's time zone.

## Decisions

### `handledByAi` is not a part of `missedCalls`

The task defines a missed call as `answered_by IS NULL`. A call the AI picked up has
`answered_by = 'ai'`, so it can never be inside `missedCalls`. The response therefore has three
separate call numbers, not a breakdown that adds up:

- `missedCalls`: nobody picked up;
- `handledByTextBack`: some of those, texted back;
- `handledByAi`: calls the AI answered instead of the office.

The dashboard can label them "Missed calls: 14, texted back: 9" and "Answered by AI: 6". If the
owner wants "calls the office didn't answer" (= missed + AI), the screen adds the two.

### Text-back counts only once it went out

A text-back the compliance gate blocked (no consent, STOP) or that failed did not reach the
caller, so it didn't handle anything. `queued` doesn't count either: `text_back` skips quiet
hours, so it is queued for seconds at most. Two text-backs for one call still count the call once
(`exists`, not a join).

The call is counted in the range by when it **rang**, not when the text went out, so
`handledByTextBack <= missedCalls` always holds.

### The recovered-job rule lives once, in billing

`countRecoveredJobs()` already decides which jobs are "recovered" for the per-job fee: recovered
source, not cancelled, `booked_at` in the period. The dashboard must show the same count the
owner is billed for. So the `where` condition moves to one exported function in
`billing.queries.ts`, `recoveredJobsBookedIn(tenantId, timezone, periodStart, periodEnd)`, and
both `countRecoveredJobs()` and the analytics query use it.

```
analytics.routes ─► analytics.service ─► analytics.queries ─► billing.queries  recoveredJobsBookedIn()
                          │                     └───────────► lib/local-day.ts  startOfLocalDay()
                          └► dispatch.queries  findTimezone()
billing.queries ─► lib/local-day.ts
```

One way only: billing never imports analytics.

### Revenue follows the booking date, not the payment date

`revenueCents` sums the paid invoices of exactly the jobs in `jobsBooked`, so "5 jobs, $1,845"
always describes the same jobs. A job booked 30 September and paid 2 October is September's
revenue. The cost: a past range's revenue can still grow when an old invoice is paid. That is
the honest number ("what the jobs Relay recovered in September earned"), and the task says
"revenue from those jobs".

A job with an open or void invoice, or none, is in `jobsBooked` and adds 0. The join is a
`left join` on `(tenant_id, job_id)`; `invoices` is unique on that pair, so a job is never
counted twice.

### Local dates, both ends inclusive

The owner picks "1 Oct to 31 Oct", so `to` is inclusive. The service turns it into an exclusive
end with `nextDay(to)`, the shape billing already uses (`periodStart`, `periodEnd`). Day starts
are worked out in Postgres (`'2026-10-01'::date::timestamp at time zone 'America/Phoenix'`), the
same expression billing uses today, moved to `startOfLocalDay()` so both share it.

No maximum range: the query is limited to one contractor and pilot volumes are small.

## Code changes

- `src/lib/local-day.ts` (new): `startOfLocalDay(day, timezone)` (SQL) and `nextDay(day)` (pure).
- `src/modules/billing/billing.queries.ts`: new exported `recoveredJobsBookedIn(...)`;
  `countRecoveredJobs()` uses it. Behavior unchanged.
- `src/modules/analytics/` (new module):
  - `analytics.schemas.ts`: `RecoveryQuery` (`from`, `to`, `to >= from`);
  - `analytics.queries.ts`: `countCalls()` and `sumRecoveredJobs()`;
  - `analytics.service.ts`: `getRecovery(user, range)`;
  - `analytics.routes.ts`: `GET /analytics/recovery`, owner only;
  - `analytics.test.ts`.
- `src/app.ts`: mount `analyticsRoutes`.

## Edge cases

| Case | Result |
|---|---|
| Missed call at 23:30 Phoenix on 31 Oct (1 Nov in UTC), range Oct | counted |
| Missed call at 23:30 Phoenix on 30 Sep, range Oct | not counted |
| Call answered by `office` | in no number |
| AI call that was transferred to staff (`transferred_at` set) | `handledByAi` |
| AI call with `safety_flag` (gas, no booking) | `handledByAi` |
| Missed call, text-back `sent` or `delivered` | `handledByTextBack` |
| Missed call, text-back `blocked` / `failed` / `queued` | missed, not handled |
| Missed call, two text-backs | handled once |
| Missed call with a `missed_caller_reminder` only | missed, not handled |
| Recovered job booked in range, then cancelled | not in `jobsBooked` (same as billing) |
| Recovered job still `held` (no `booked_at`) | not counted |
| Recovered job booked in range, invoice `paid` | counted, total in `revenueCents` |
| Same, invoice `open` / `void` / none | counted, adds 0 |
| `web` or `office` job with a paid invoice | in neither number |
| Another contractor's calls, jobs, invoices | never counted |
| Range with no data | all numbers 0 |
| `from` = `to` | that one local day |
| `to` before `from`, `2026-02-31`, missing param | 400 `validation_failed` |
| Office user / signed out | 403 / 401 |

## Performance

- Calls: `calls_tenant_started_idx (tenant_id, started_at desc)` covers the range. The text-back
  `exists` looks up `messages` by `(tenant_id, call_id)` with no index; fine for a pilot (a few
  hundred calls a month). Add a partial index on `messages (tenant_id, call_id) where call_id is
  not null` if it ever shows up as slow.
- Jobs: filtered by `tenant_id` first, then source and `booked_at`; the invoice join uses
  `invoices (tenant_id, job_id)` (unique). Same plan billing runs daily.
- Two queries, run with `Promise.all`.

## Testing

- `src/lib/local-day.test.ts`: `nextDay` on a normal day, month end, year end, 28 Feb in a leap
  year and in a normal year.
- `src/modules/analytics/analytics.test.ts` (over HTTP, Phoenix tenant from `createShop`):
  - 401 signed out, 403 office, 400 for `to` before `from`, an impossible date, a missing `to`;
  - calls: every call row in the edge-case table, one request, exact numbers;
  - jobs and revenue: every job row in the edge-case table, exact numbers;
  - a second contractor with the same data changes nothing;
  - an empty range answers zeros and echoes `from` and `to`.
- `billing.test.ts` passes unchanged (the refactor keeps the count).
