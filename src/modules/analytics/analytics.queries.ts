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
      textBack:
        sql<number>`count(*) filter (where ${calls.answeredBy} is null and ${textBackSent})`.mapWith(
          Number,
        ),
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
export async function sumRecoveredJobs(
  tenantId: string,
  timezone: string,
  start: string,
  end: string,
) {
  const [row] = await db
    .select({
      jobs: count(jobs.id),
      revenueCents:
        sql<number>`coalesce(sum(${invoices.totalCents}) filter (where ${invoices.status} = 'paid'), 0)`.mapWith(
          Number,
        ),
    })
    .from(jobs)
    .leftJoin(invoices, and(eq(invoices.tenantId, jobs.tenantId), eq(invoices.jobId, jobs.id)))
    .where(recoveredJobsBookedIn(tenantId, timezone, start, end))
  return row
}

// Like sumRecoveredJobs, per local week of booked_at: the week's Monday as '2026-07-20'.
// Weeks with no recovered job have no row.
export function sumRecoveredJobsByWeek(
  tenantId: string,
  timezone: string,
  start: string,
  end: string,
) {
  return (
    db
      .select({
        // date_trunc('week', …) starts weeks on Monday.
        weekStart: sql<string>`to_char(date_trunc('week', ${jobs.bookedAt} at time zone ${timezone}), 'YYYY-MM-DD')`,
        jobs: count(jobs.id),
        revenueCents:
          sql<number>`coalesce(sum(${invoices.totalCents}) filter (where ${invoices.status} = 'paid'), 0)`.mapWith(
            Number,
          ),
      })
      .from(jobs)
      .leftJoin(invoices, and(eq(invoices.tenantId, jobs.tenantId), eq(invoices.jobId, jobs.id)))
      .where(recoveredJobsBookedIn(tenantId, timezone, start, end))
      // By the first column: repeating the week expression would send the time zone as a second
      // parameter, and Postgres can't tell the two are the same.
      .groupBy(sql`1`)
  )
}
