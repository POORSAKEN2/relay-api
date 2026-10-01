import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../../db/client.ts'
import { customers, jobs, properties, services, tenants } from '../../db/schema.ts'
import { local } from '../dispatch/dispatch.queries.ts'

// Tenant-scoped: every query takes tenantId first. The job page reuses the dispatch module's
// queries; only the list needs its own.

// The statuses a technician sees: assigned and not called off. 'held', 'expired' and
// 'cancelled' never show.
export const VISIBLE_STATUSES = ['booked', 'en_route', 'in_progress', 'no_access', 'done'] as const

// A technician's jobs from the start of the contractor's local today, for `days` days, in the
// order the list shows them: by day, done last, then by window, PRIORITY first, oldest first.
export function listTechnicianJobs(tenantId: string, technicianId: string, days: number) {
  const today = sql`(now() at time zone ${tenants.timezone})::date`
  return db
    .select({
      id: jobs.id,
      status: jobs.status,
      priority: jobs.priority,
      date: local(jobs.windowStartsAt, 'YYYY-MM-DD'),
      localStart: local(jobs.windowStartsAt, 'HH24:MI:SS'),
      localEnd: local(jobs.windowEndsAt, 'HH24:MI:SS'),
      customerName: customers.name,
      street: properties.street,
      city: properties.city,
      serviceName: services.name,
    })
    .from(jobs)
    .innerJoin(tenants, eq(tenants.id, jobs.tenantId))
    .innerJoin(customers, eq(customers.id, jobs.customerId))
    .innerJoin(properties, eq(properties.id, jobs.propertyId))
    .innerJoin(services, eq(services.id, jobs.serviceId))
    .where(
      and(
        eq(jobs.tenantId, tenantId),
        eq(jobs.technicianId, technicianId),
        inArray(jobs.status, [...VISIBLE_STATUSES]),
        sql`${jobs.windowStartsAt} >= ${today}::timestamp at time zone ${tenants.timezone}`,
        sql`${jobs.windowStartsAt} < (${today} + ${days}::int)::timestamp at time zone ${tenants.timezone}`,
      ),
    )
    .orderBy(
      local(jobs.windowStartsAt, 'YYYY-MM-DD'),
      sql`${jobs.status} = 'done'`,
      asc(jobs.windowStartsAt),
      desc(jobs.priority),
      asc(jobs.createdAt),
    )
}
