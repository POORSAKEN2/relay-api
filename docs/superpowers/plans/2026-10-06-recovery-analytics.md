# Recovery Analytics API Implementation Plan

**Goal:** `GET /api/analytics/recovery?from=YYYY-MM-DD&to=YYYY-MM-DD` returns, for the owner's
contractor and a range of local dates: missed calls, how many were texted back, how many calls
the AI answered, recovered jobs booked, and the paid invoice revenue from those jobs.

**Architecture:** New `analytics` module (routes → service → queries), owner only. Two queries:
one over `calls` (with an `exists` on `messages` for the text-back), one over recovered `jobs`
left-joined to `invoices`. "Recovered job" is billing's rule, moved into one exported condition
that both billing and analytics use. Local-day maths moves to `src/lib/local-day.ts`. No schema
change, no new dependency, no `relay-web` change.

**Spec:** `relay-api/docs/superpowers/specs/2026-10-06-recovery-analytics-design.md`

## Global Constraints

- Branch `feat/recovery-analytics` in `relay-api`, from `main`. The working tree has
  uncommitted voice/Telnyx work (`src/app.ts`, `src/config/env.ts`, `src/modules/voice/`, …):
  stash or commit it first and never stage it with this task's commits.
- Lean, plain code a junior developer can debug without AI. Short "why" comments.
- Commit messages lowercase conventional (`feat: …`, `refactor: …`). No `Co-Authored-By` trailer.
- Biome only on touched files: `npx biome check --write <paths>`.
- Tests need the local test database (`npm test` uses `test/global-setup.ts`).

## Task 1: local-day helpers, billing uses them

- [x] New `src/lib/local-day.ts`:
      ```ts
      import { sql } from 'drizzle-orm'

      // The instant a contractor's local day starts, worked out by Postgres:
      // '2026-09-01' in America/Phoenix is 2026-09-01 07:00 UTC.
      export function startOfLocalDay(day: string, timezone: string) {
        return sql`${day}::date::timestamp at time zone ${timezone}`
      }

      // '2026-10-31' → '2026-11-01'. Turns an inclusive last day into an exclusive end.
      export function nextDay(day: string) {
        const date = new Date(`${day}T00:00:00Z`)
        date.setUTCDate(date.getUTCDate() + 1)
        return date.toISOString().slice(0, 10)
      }
      ```
- [x] New `src/lib/local-day.test.ts` for `nextDay`: `'2026-10-06'` → `'2026-10-07'`,
      `'2026-10-31'` → `'2026-11-01'`, `'2026-12-31'` → `'2027-01-01'`,
      `'2028-02-28'` → `'2028-02-29'`, `'2026-02-28'` → `'2026-03-01'`.
- [x] `src/modules/billing/billing.queries.ts`: pull the `where` of `countRecoveredJobs()` out
      into an exported condition, and use `startOfLocalDay`:
      ```ts
      // Recovered jobs booked from periodStart up to (not including) periodEnd, local dates in
      // the contractor's time zone. Holds nobody paid for have no booked_at, so they never
      // count; a cancelled job doesn't count either. The per-job fee and the recovery dashboard
      // both use this, so the owner is billed for exactly the jobs the dashboard shows.
      export function recoveredJobsBookedIn(
        tenantId: string,
        timezone: string,
        periodStart: string,
        periodEnd: string,
      ) {
        return and(
          eq(jobs.tenantId, tenantId),
          inArray(jobs.source, [...RECOVERED_JOB_SOURCES]),
          ne(jobs.status, 'cancelled'),
          gte(jobs.bookedAt, startOfLocalDay(periodStart, timezone)),
          lt(jobs.bookedAt, startOfLocalDay(periodEnd, timezone)),
        )
      }

      export async function countRecoveredJobs(...same params) {
        const [row] = await db
          .select({ count: count() })
          .from(jobs)
          .where(recoveredJobsBookedIn(tenantId, timezone, periodStart, periodEnd))
        return row.count
      }
      ```
      `listTenantsToInvoice()` keeps its own `date_trunc` SQL (it is a different calculation).
- [x] `npm test -- local-day billing` passes; `billing.test.ts` unchanged.
- [x] Commit `refactor: one recovered-job rule and local-day helpers for billing and analytics`.

## Task 2: the analytics module

- [x] `src/modules/analytics/analytics.schemas.ts`:
      ```ts
      import { z } from 'zod'
      import { LocalDate } from '../../lib/fields.ts'

      // A range of the contractor's local dates, both days included.
      export const RecoveryQuery = z
        .object({ from: LocalDate, to: LocalDate })
        .refine(({ from, to }) => from <= to, {
          message: 'The end date must be on or after the start date',
          path: ['to'],
        })
      export type RecoveryQuery = z.infer<typeof RecoveryQuery>
      ```
      (`'YYYY-MM-DD'` strings compare correctly as text.)
- [x] `src/modules/analytics/analytics.queries.ts`:
      ```ts
      import { and, count, eq, exists, gte, inArray, lt, sql } from 'drizzle-orm'
      import { db } from '../../db/client.ts'
      import { calls, invoices, jobs, messages } from '../../db/schema.ts'
      import { startOfLocalDay } from '../../lib/local-day.ts'
      import { recoveredJobsBookedIn } from '../billing/billing.queries.ts'

      // A missed call counts as texted back once a text-back reached the phone network. One
      // the compliance gate blocked (no consent, STOP) or that failed didn't reach the caller.
      const textBackSent = exists(
        db
          .select({ one: sql`1` })
          .from(messages)
          .where(
            and(
              eq(messages.tenantId, calls.tenantId),
              eq(messages.callId, calls.id),
              eq(messages.kind, 'text_back'),
              inArray(messages.status, ['sent', 'delivered']),
            ),
          ),
      )

      // Calls that rang from start up to (not including) end, local dates. A missed call is one
      // nobody picked up (answered_by null); an AI-answered call is never a missed one.
      export async function countCalls(tenantId: string, timezone: string, start: string, end: string) {
        const [row] = await db
          .select({
            missed: sql<number>`count(*) filter (where ${calls.answeredBy} is null)`.mapWith(Number),
            textBack: sql<number>`count(*) filter (where ${calls.answeredBy} is null and ${textBackSent})`.mapWith(Number),
            ai: sql<number>`count(*) filter (where ${calls.answeredBy} = 'ai')`.mapWith(Number),
          })
          .from(calls)
          .where(
            and(
              eq(calls.tenantId, tenantId),
              gte(calls.startedAt, startOfLocalDay(start, timezone)),
              lt(calls.startedAt, startOfLocalDay(end, timezone)),
            ),
          )
        return row
      }

      // Recovered jobs booked in the range (billing's rule) and what their paid invoices came
      // to. One invoice per job at most, so the left join never counts a job twice.
      export async function sumRecoveredJobs(tenantId: string, timezone: string, start: string, end: string) {
        const [row] = await db
          .select({
            jobs: count(jobs.id),
            revenueCents: sql<number>`coalesce(sum(${invoices.totalCents}) filter (where ${invoices.status} = 'paid'), 0)`.mapWith(Number),
          })
          .from(jobs)
          .leftJoin(invoices, and(eq(invoices.tenantId, jobs.tenantId), eq(invoices.jobId, jobs.id)))
          .where(recoveredJobsBookedIn(tenantId, timezone, start, end))
        return row
      }
      ```
      Check: in the first `npm test` run, confirm the `exists` subquery's `calls` columns
      render as the outer `"calls"."id"` (correlated). If Drizzle renders it wrongly, replace
      `textBackSent` with the plain `sql\`exists (select 1 from ...)\`` form.
- [x] `src/modules/analytics/analytics.service.ts`:
      ```ts
      import { nextDay } from '../../lib/local-day.ts'
      import type { SessionUser } from '../accounts/accounts.service.ts'
      import { tenantOf } from '../booking/booking.service.ts'
      import { findTimezone } from '../dispatch/dispatch.queries.ts'
      import type { RecoveryQuery } from './analytics.schemas.ts'
      import * as queries from './analytics.queries.ts'

      // The recovered-revenue dashboard's numbers for one range of local dates. See the spec
      // for what each number counts.
      export async function getRecovery(user: SessionUser, { from, to }: RecoveryQuery) {
        const tenantId = tenantOf(user)
        const timezone = await findTimezone(tenantId)
        const end = nextDay(to) // `to` is included
        const [calls, recovered] = await Promise.all([
          queries.countCalls(tenantId, timezone, from, end),
          queries.sumRecoveredJobs(tenantId, timezone, from, end),
        ])
        return {
          from,
          to,
          missedCalls: calls.missed,
          handledByTextBack: calls.textBack,
          handledByAi: calls.ai,
          jobsBooked: recovered.jobs,
          revenueCents: recovered.revenueCents,
        }
      }
      ```
- [x] `src/modules/analytics/analytics.routes.ts`:
      ```ts
      import { Router } from 'express'
      import { requireRole } from '../../middleware/auth.ts'
      import { RecoveryQuery } from './analytics.schemas.ts'
      import * as analytics from './analytics.service.ts'

      export const analyticsRoutes = Router()

      // Owner only, like billing: the MVP's recovered-revenue dashboard is the owner's, and it
      // shows revenue.
      analyticsRoutes.get('/analytics/recovery', requireRole('owner'), async (req, res) => {
        res.json(await analytics.getRecovery(req.user!, RecoveryQuery.parse(req.query)))
      })
      ```
- [x] `src/app.ts`: import `analyticsRoutes` and add it first in the `app.use('/api', …)` list
      (alphabetical). Only that line and the import: leave the uncommitted voice changes out of
      the commit (`git add -p src/app.ts`).
- [x] `src/modules/analytics/analytics.test.ts` (supertest, `resetDb` in `beforeEach` like
      `billing.test.ts`). Local helpers at the top of the file:
  - `phoenix(local)` → `new Date(\`${local}-07:00\`)`.
  - `owner(shop)` → `createUser('owner', shop.tenant.id)` then `signIn(email)` (cookie).
  - `createCall(shop, values)` → insert into `calls` with `providerSid: randomUUID()`,
    `toPhone: '+14805550100'`, `fromPhone: '+16025550111'`, plus `values` (`answeredBy`,
    `startedAt`; `disclosedAt: new Date()` whenever `answeredBy` is `'ai'`, for the check).
  - `createTextBack(shop, callId, status)` → insert into `messages`: `channel: 'sms'`,
    `direction: 'outbound'`, `kind: 'text_back'`, `contact: '+16025550111'`, `body: 'Sorry we
    missed you'`, `callId`, `status`, and `blockedReason: 'no_consent'` when `status` is
    `'blocked'`.
  - `createInvoice(shop, jobId, status, totalCents)` → insert into `invoices` with an
    incrementing `number`, and `paidAt: new Date()` when `status` is `'paid'`.
  - `getRecovery(cookie, query)` → `request(app).get('/api/analytics/recovery').query(query)`.

  Tests (range `from: '2026-10-01', to: '2026-10-31'` unless noted):
  - **access:** 401 signed out; 403 with `shop.cookie` (office).
  - **validation:** 400 `validation_failed` for `to` before `from`, `from: '2026-02-31'`, and no
    `to`.
  - **calls:** one shop with
    - missed `2026-10-01T00:00` (first instant), missed `2026-10-31T23:30` (1 Nov in UTC): counted;
    - missed `2026-09-30T23:30` and `2026-11-01T00:00`: not counted;
    - text-backs on in-range missed calls: one `sent`, one `delivered`, one call with two `sent`,
      one `blocked`, one `failed`, one `queued`;
    - a `sent` text-back on the out-of-range missed call;
    - `office` call in range; two `ai` calls in range (one with `transferredAt`, one with
      `safetyFlag: true`); one `ai` call out of range.

    Expect `missedCalls` = in-range missed calls, `handledByTextBack: 3` (sent, delivered, the
    double), `handledByAi: 2`.
  - **jobs and revenue** (`createJob` from `test/helpers.ts`, `bookedAt` set explicitly):
    - `text_back` booked in range, invoice `paid` 12000: counted, adds 12000;
    - `ai` booked `2026-10-31T23:00`, invoice `paid` 8900: counted, adds 8900;
    - `recovery_text` booked in range, invoice `open` 5000: counted, adds 0;
    - `ai` booked in range, invoice `void` 7000: counted, adds 0;
    - `text_back` booked in range, no invoice: counted, adds 0;
    - `text_back` booked in range, `status: 'cancelled'`, invoice `paid`: not counted;
    - `ai` `status: 'held'`, `holdExpiresAt` set, `bookedAt: null`: not counted;
    - `recovery_text` booked `2026-09-30T23:30`, invoice `paid`: not counted;
    - `web` and `office` jobs booked in range, invoice `paid`: not counted.

    Expect `jobsBooked: 5`, `revenueCents: 20900`.
  - **other contractor:** `createShop('cool')` with a missed call, a `sent` text-back, an `ai`
    call and a paid recovered job in range; the first shop's numbers are all 0.
  - **empty range:** `from: '2026-10-06', to: '2026-10-06'` with no data →
    `{ from: '2026-10-06', to: '2026-10-06', missedCalls: 0, handledByTextBack: 0,
    handledByAi: 0, jobsBooked: 0, revenueCents: 0 }` (exact `toEqual`, so a `null` sum or a
    string count fails the test).
- [x] `npm test -- analytics billing local-day`; then full `npm test`; `npm run typecheck`.
- [x] `npx biome check --write` on the touched files.
- [x] Commit `feat: recovery analytics endpoint for the recovered-revenue dashboard`.

## Task 3: docs

- [x] Mark the spec `Status: built` and commit both docs:
      `docs: recovery analytics spec and plan`.

## Manual check (optional)

1. Start the API (`npm run dev`) and sign in as the demo owner (accounts in `src/db/seed.ts`).
2. In psql (`relay` database), add one missed call and a sent text-back for `desert`:
   ```sql
   with t as (select id from tenants where slug = 'desert'),
   c as (
     insert into calls (tenant_id, provider_sid, from_phone, to_phone)
     select id, 'manual-check-1', '+16025550111', '+14805550100' from t
     returning tenant_id, id
   )
   insert into messages (tenant_id, channel, direction, contact, kind, body, status, call_id)
   select tenant_id, 'sms', 'outbound', '+16025550111', 'text_back', 'Sorry we missed you', 'sent', id
   from c;
   ```
3. `GET /api/analytics/recovery?from=<today>&to=<today>` with the owner's cookie:
   `missedCalls: 1`, `handledByTextBack: 1`, and `jobsBooked` = the seeded `text_back` /
   `ai` / `recovery_text` jobs booked today (the seed sets `booked_at` to now).
4. Clean up:
   ```sql
   delete from messages where call_id in (select id from calls where provider_sid = 'manual-check-1');
   delete from calls where provider_sid = 'manual-check-1';
   ```
