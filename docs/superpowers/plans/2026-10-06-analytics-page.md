# Recovered-Revenue Page Implementation Plan

**Goal:** `relay-web/src/routes/analytics.tsx` shows real recovery numbers for a chosen range and
a 12-week revenue chart. Owner only.

**Architecture:** One new owner-only endpoint `GET /api/analytics/recovery/weekly` in the
existing `analytics` module, reusing billing's recovered-job rule. In `relay-web`, a
`features/analytics` folder with the query hooks, the range presets and a plain CSS bar chart.

**Spec:** `relay-api/docs/superpowers/specs/2026-10-06-analytics-page-design.md`

## Global Constraints

- Branch `feat/analytics-page` in `relay-api` and `relay-web`, from `main`.
- Lean, plain code a junior developer can debug without AI. No chart library.
- Commit messages lowercase conventional. No `Co-Authored-By` trailer.
- Biome only on touched files.

## Task 1: weekly endpoint (relay-api)

- [ ] `src/lib/local-day.ts`: `addDays(day, n)` (generalizes `nextDay`, which becomes
      `addDays(day, 1)`), `mondayOf(day)`. Tests in `local-day.test.ts` (a Monday, a Sunday,
      across a month and a year end).
- [ ] `analytics.schemas.ts`: `WeeklyQuery { weeks: z.coerce.number().int().min(1).max(26).default(12) }`.
- [ ] `analytics.queries.ts`: `sumRecoveredJobsByWeek(tenantId, timezone, start, end)`:
      same select as `sumRecoveredJobs`, plus
      `to_char(date_trunc('week', jobs.booked_at at time zone ${timezone}), 'YYYY-MM-DD') as week`,
      `group by week`. `date_trunc('week', …)` starts weeks on Monday.
- [ ] `analytics.service.ts → getWeekly(user, { weeks })`: today in the contractor's zone
      (`findTimezone`, then `localToday(timezone)` with `Intl.DateTimeFormat`), `lastMonday =
      mondayOf(today)`, `first = addDays(lastMonday, -7 * (weeks - 1))`, query
      `[first, addDays(lastMonday, 7))`, then fill missing weeks with zeros in order.
- [ ] `analytics.routes.ts`: `GET /analytics/recovery/weekly`, `requireRole('owner')`.
      Register it **before** any route that could match `/analytics/recovery/:something`
      (there is none today; keep it that way).
- [ ] Tests in `analytics.test.ts` (spec's list).
- [ ] Commit `feat: recovered revenue by week`.

## Task 2: data hooks and helpers (relay-web)

- [ ] `src/features/analytics/api.ts`: zod `Recovery` and `Weekly`; `useRecovery(range)` and
      `useWeekly()` with React Query (key `['analytics', 'recovery', from, to]` and
      `['analytics', 'weekly']`).
- [ ] `src/features/analytics/ranges.ts` (+ test): `PRESETS` (`this_month`, `last_month`,
      `last_90_days`, with labels) and `rangeFor(preset, today: string)` → `{ from, to }`.
- [ ] `src/features/analytics/bars.ts` (+ test): `barHeights(weeks)` → percent per week.
- [ ] Commit `feat: analytics hooks, range presets and bar sizes`.

## Task 3: the page

- [ ] `src/features/analytics/revenue-chart.tsx`: a flex row of bars (`style={{ height: \`${h}%\` }}`,
      `bg-primary`, rounded top), week labels from `formatShortDate`, `title` with the amount, and
      an `sr-only` table with the same numbers.
- [ ] `src/routes/analytics.tsx`: replace `STATS` with the hook data; range `Select` in the page
      header; loading skeletons; error with retry; empty state kept for all-zero weeks. Money with
      the existing currency formatter in `lib/format.ts`.
- [ ] Owner only: `router.tsx` wraps `/analytics` in the owner role check (as other owner-only
      pages do, see `features/auth/require-role.tsx`); `sidebar-links.ts` entries get an optional
      `roles` and the sidebar hides links the user's role can't open.
- [ ] Check in headless Edge at phone width and desktop, signed in as owner and as office.
- [ ] Commit `feat: recovered-revenue page shows real numbers and a weekly chart`.
