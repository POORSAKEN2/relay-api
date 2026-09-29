import { and, asc, count, eq, isNull, ne, notInArray, sql } from 'drizzle-orm'
import { type Db, db, type Tx } from '../../db/client.ts'
import { arrivalWindows, consentEvents, jobs, services, tenants } from '../../db/schema.ts'

// Tenant-scoped: every query takes tenantId first.

// Statuses that don't hold a place in their window.
export const INACTIVE_STATUSES = ['cancelled', 'expired'] as const

export function listActiveServices(tenantId: string) {
  return db
    .select({
      id: services.id,
      name: services.name,
      priceType: services.priceType,
      priceCents: services.priceCents,
    })
    .from(services)
    .where(and(eq(services.tenantId, tenantId), isNull(services.archivedAt)))
    .orderBy(asc(services.sortOrder), asc(services.name))
}

export async function findActiveService(tenantId: string, serviceId: string, tx: Db = db) {
  const [service] = await tx
    .select({ id: services.id })
    .from(services)
    .where(
      and(eq(services.tenantId, tenantId), eq(services.id, serviceId), isNull(services.archivedAt)),
    )
  return service
}

// Locks the window row until the transaction ends, so two bookings can't both count the
// same free place. Also works out the window's real start and end on `date` in the
// contractor's time zone, and whether `date` is already past there.
export async function lockWindow(tenantId: string, windowId: string, date: string, tx: Tx) {
  const [window] = await tx
    .select({
      weekday: arrivalWindows.weekday,
      startsAt: arrivalWindows.startsAt,
      endsAt: arrivalWindows.endsAt,
      jobCap: arrivalWindows.jobCap,
      windowStartsAt:
        sql`(${date}::date + ${arrivalWindows.startsAt}) at time zone ${tenants.timezone}`.mapWith(
          jobs.windowStartsAt,
        ),
      windowEndsAt:
        sql`(${date}::date + ${arrivalWindows.endsAt}) at time zone ${tenants.timezone}`.mapWith(
          jobs.windowEndsAt,
        ),
      isPast: sql<boolean>`${date}::date < (now() at time zone ${tenants.timezone})::date`,
    })
    .from(arrivalWindows)
    .innerJoin(tenants, eq(tenants.id, arrivalWindows.tenantId))
    .where(and(eq(arrivalWindows.tenantId, tenantId), eq(arrivalWindows.id, windowId)))
    .for('update', { of: arrivalWindows })
  return window
}

// Jobs holding a place in the window that starts at `startsAt`.
export async function countActiveJobsAt(
  tenantId: string,
  startsAt: Date,
  excludeJobId: string | undefined,
  tx: Db = db,
) {
  const [row] = await tx
    .select({ count: count() })
    .from(jobs)
    .where(
      and(
        eq(jobs.tenantId, tenantId),
        eq(jobs.windowStartsAt, startsAt),
        notInArray(jobs.status, [...INACTIVE_STATUSES]),
        excludeJobId ? ne(jobs.id, excludeJobId) : undefined,
      ),
    )
  return row.count
}

export async function insertJob(
  tenantId: string,
  values: Omit<typeof jobs.$inferInsert, 'tenantId'>,
  tx: Db = db,
) {
  const [job] = await tx
    .insert(jobs)
    .values({ ...values, tenantId })
    .returning({ id: jobs.id, priority: jobs.priority })
  return job
}

export async function insertConsent(
  tenantId: string,
  values: Omit<typeof consentEvents.$inferInsert, 'tenantId'>,
  tx: Db = db,
) {
  await tx.insert(consentEvents).values({ ...values, tenantId })
}
