import { and, asc, eq, gte, inArray, notInArray, sql } from 'drizzle-orm'
import { type Db, db, type Tx } from '../../db/client.ts'
import { arrivalWindows, businessHours, jobs, tenants } from '../../db/schema.ts'
import { INACTIVE_STATUSES } from '../booking/booking.queries.ts'
import { local } from '../dispatch/dispatch.queries.ts'

// Tenant-scoped: every query takes tenantId first. Times are the contractor's wall clock, as
// Postgres returns them ('08:00:00').

export function listHours(tenantId: string, tx: Db = db) {
  return tx
    .select({
      weekday: businessHours.weekday,
      opensAt: businessHours.opensAt,
      closesAt: businessHours.closesAt,
    })
    .from(businessHours)
    .where(eq(businessHours.tenantId, tenantId))
    .orderBy(asc(businessHours.weekday))
}

export function listWindows(tenantId: string, tx: Db = db) {
  return tx
    .select({
      id: arrivalWindows.id,
      weekday: arrivalWindows.weekday,
      startsAt: arrivalWindows.startsAt,
      endsAt: arrivalWindows.endsAt,
      jobCap: arrivalWindows.jobCap,
    })
    .from(arrivalWindows)
    .where(eq(arrivalWindows.tenantId, tenantId))
    .orderBy(asc(arrivalWindows.weekday), asc(arrivalWindows.startsAt))
}

// Swaps the contractor's hours for `rows` (none: closed every day).
export async function replaceHours(
  tenantId: string,
  rows: { weekday: number; opensAt: string; closesAt: string }[],
  tx: Tx,
) {
  await tx.delete(businessHours).where(eq(businessHours.tenantId, tenantId))
  if (rows.length > 0) {
    await tx.insert(businessHours).values(rows.map((row) => ({ tenantId, ...row })))
  }
}

export async function deleteWindows(tenantId: string, ids: string[], tx: Tx) {
  if (ids.length === 0) return
  await tx
    .delete(arrivalWindows)
    .where(and(eq(arrivalWindows.tenantId, tenantId), inArray(arrivalWindows.id, ids)))
}

// Never changes starts_at, so it can't clash with the (tenant, weekday, starts_at) key.
export async function updateWindow(
  tenantId: string,
  id: string,
  values: { endsAt: string; jobCap: number },
  tx: Tx,
) {
  await tx
    .update(arrivalWindows)
    .set(values)
    .where(and(eq(arrivalWindows.tenantId, tenantId), eq(arrivalWindows.id, id)))
}

export async function insertWindows(
  tenantId: string,
  rows: { weekday: number; startsAt: string; endsAt: string; jobCap: number }[],
  tx: Tx,
) {
  if (rows.length === 0) return
  await tx.insert(arrivalWindows).values(rows.map((row) => ({ tenantId, ...row })))
}

// Jobs from now on still holding a place, as the contractor's wall clock: weekday and
// 'HH:MM' start and end.
export function listUpcomingJobs(tenantId: string, tx: Db = db) {
  return tx
    .select({
      weekday:
        sql<number>`extract(dow from ${jobs.windowStartsAt} at time zone ${tenants.timezone})`.mapWith(
          Number,
        ),
      startsAt: local(jobs.windowStartsAt, 'HH24:MI'),
      endsAt: local(jobs.windowEndsAt, 'HH24:MI'),
    })
    .from(jobs)
    .innerJoin(tenants, eq(tenants.id, jobs.tenantId))
    .where(
      and(
        eq(jobs.tenantId, tenantId),
        notInArray(jobs.status, [...INACTIVE_STATUSES, 'done' as const]),
        gte(jobs.windowStartsAt, sql`now()`),
      ),
    )
}
