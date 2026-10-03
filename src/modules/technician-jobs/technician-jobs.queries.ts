import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { type Db, db } from '../../db/client.ts'
import { customers, jobs, properties, services, tenants, users } from '../../db/schema.ts'
import { local, localOrNull } from '../dispatch/dispatch.queries.ts'

// Tenant-scoped: every query takes tenantId first. The job page reuses the dispatch module's
// queries; only the list needs its own.

// The statuses a technician sees: assigned and not called off. 'held', 'expired' and
// 'cancelled' never show.
export const VISIBLE_STATUSES = ['booked', 'en_route', 'in_progress', 'no_access', 'done'] as const

// The contractor's local today, in SQL. Needs `tenants` joined.
const today = sql`(now() at time zone ${tenants.timezone})::date`

// A job card's columns, joined and ready for a where clause.
function selectCards() {
  return db
    .select({
      id: jobs.id,
      status: jobs.status,
      priority: jobs.priority,
      date: local(jobs.windowStartsAt, 'YYYY-MM-DD'),
      localStart: local(jobs.windowStartsAt, 'HH24:MI:SS'),
      localEnd: local(jobs.windowEndsAt, 'HH24:MI:SS'),
      etaLocal: localOrNull(jobs.etaAt, 'HH24:MI:SS'),
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
}

// A technician's jobs from the start of the contractor's local today, for `days` days, in the
// order the list shows them: by day, done last, then by window, PRIORITY first, oldest first.
export function listTechnicianJobs(tenantId: string, technicianId: string, days: number) {
  return selectCards()
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

// Unfinished visits from before today, oldest first, so a technician can finish yesterday's
// job. No access jobs are left out: rescheduling them is the office's job.
export function listEarlierTechnicianJobs(tenantId: string, technicianId: string) {
  return selectCards()
    .where(
      and(
        eq(jobs.tenantId, tenantId),
        eq(jobs.technicianId, technicianId),
        inArray(jobs.status, ['booked', 'en_route', 'in_progress']),
        sql`${jobs.windowStartsAt} < ${today}::timestamp at time zone ${tenants.timezone}`,
      ),
    )
    .orderBy(asc(jobs.windowStartsAt))
}

// Who to text about a job and how to sign it: the homeowner's phone, the contractor's name and
// time zone, the technician's name. Read inside the transaction that changes the job.
export async function findJobContact(tenantId: string, jobId: string, tx: Db) {
  const [contact] = await tx
    .select({
      contractorName: tenants.name,
      timezone: tenants.timezone,
      customerId: customers.id,
      customerPhone: customers.phone,
      technicianName: users.name,
    })
    .from(jobs)
    .innerJoin(tenants, eq(tenants.id, jobs.tenantId))
    .innerJoin(customers, eq(customers.id, jobs.customerId))
    .innerJoin(users, eq(users.id, jobs.technicianId))
    .where(and(eq(jobs.tenantId, tenantId), eq(jobs.id, jobId)))
  return contact
}
export type JobContact = Awaited<ReturnType<typeof findJobContact>>

// Sets the equipment on the job's address.
export async function updateJobEquipment(
  tenantId: string,
  jobId: string,
  values: { equipmentBrand: string | null; equipmentYear: number | null },
  tx: Db,
) {
  await tx
    .update(properties)
    .set(values)
    .where(
      and(
        eq(properties.tenantId, tenantId),
        eq(
          properties.id,
          sql`(select ${jobs.propertyId} from ${jobs} where ${jobs.tenantId} = ${tenantId} and ${jobs.id} = ${jobId})`,
        ),
      ),
    )
}
