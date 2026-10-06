# Recovered-revenue page

Date: 2026-10-06. Status: proposed. Plan: `docs/superpowers/plans/2026-10-06-analytics-page.md`.
Depends on: `GET /api/analytics/recovery` (built, `specs/2026-10-06-recovery-analytics-design.md`).
Roadmap: `specs/2026-10-06-mvp-remaining-work.md` (step 3).

## Problem

MVP module 11 (owner, web, readable on a phone): missed calls and how many the AI or text-back
handled, jobs booked from recovery, revenue from those jobs. The API exists; the page
(`relay-web/src/routes/analytics.tsx`) shows `—` everywhere and an empty chart box.

## Goal

1. The four cards show real numbers for a chosen range.
2. A chart shows recovered revenue by week for the last 12 weeks.
3. Owner only, like the API. Office users don't see the link.

## Out of scope

- Per-source breakdown of jobs (text-back vs AI vs recovery text). Later, if owners ask.
- Export of the numbers (the full data export already has everything).
- An `office_estimated_value_cents` column. Revenue stays "paid invoice totals" (decided in the
  API spec). Payments recorded in person already write paid invoices.

## Decisions

### Revenue is paid invoices, as the API already does

Payments are recorded in person (decision 2026-10-03), and `recordPaymentInPerson` writes a
`paid` invoice. That is the clean, verifiable number. A recovered job not yet paid adds $0
until the technician records payment.

### Weekly chart: a second endpoint

```
GET /api/analytics/recovery/weekly?weeks=12
```

Owner only. `weeks`: 1 to 26, default 12. Weeks start on Monday in the contractor's time zone;
the last one is the current week.

```json
{
  "weeks": [
    { "weekStart": "2026-07-20", "jobsBooked": 3, "revenueCents": 54000 },
    { "weekStart": "2026-07-27", "jobsBooked": 0, "revenueCents": 0 }
  ]
}
```

Same rules as `jobsBooked` and `revenueCents` in the range endpoint (billing's recovered-job
rule, paid invoices of those jobs), grouped by the local week of `booked_at`. Weeks with nothing
are filled with zeros, so there are always exactly `weeks` entries, oldest first.

A separate endpoint (not a field on the range response) because its range is "the last N weeks"
whatever range the cards show.

### Plain CSS bars, no chart library

Twelve bars with a label each are a few `div`s with a height in percent. No Recharts or Chart.js
dependency to learn, update and ship. Each bar has a `title` with the exact amount, and a
visually hidden table gives screen readers the same numbers.

### Range picker: three presets

"This month" (default), "Last month", "Last 90 days". A pure helper turns a preset and today's
date into `{ from, to }`. Today is the browser's date; the contractor and their staff are in the
same time zone in practice.

## Screen

- Range select at the top right.
- Cards:
  1. **Missed calls**: `missedCalls`. Hint: "`handledByTextBack` texted back".
  2. **Answered by AI**: `handledByAi`. Hint: "Calls the AI picked up for you".
  3. **Jobs booked from recovery**: `jobsBooked`.
  4. **Recovered revenue**: `revenueCents` as dollars.
- Chart card "Recovered revenue by week": bars, week label under each ("Jul 20"), amount on
  hover / focus. All zero: the existing "No recovered jobs yet" box.
- Loading: skeleton numbers. Error: the shared error text with a Try again button.

## Testing

- API `analytics.test.ts`: weekly endpoint: 12 entries oldest first; a job booked Sunday 23:30
  Phoenix counts in that week, not the next; cancelled and unpaid as in the range endpoint;
  office 403; `weeks=0` and `weeks=27` → 400.
- `lib/local-day.test.ts`: the week helper (`mondayOf(day)`, `addDays(day, n)`).
- `relay-web`: `rangeFor(preset, today)` for each preset, including January ("Last month" =
  December of the previous year); `barHeights(weeks)` (the tallest is 100%, all zero gives 0).
