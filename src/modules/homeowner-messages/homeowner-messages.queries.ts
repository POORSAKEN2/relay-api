import { and, eq, isNotNull, notExists, or, sql } from 'drizzle-orm'
import { type Db, db } from '../../db/client.ts'
import { customers, jobs, messages, services, tenants } from '../../db/schema.ts'
import { local } from '../dispatch/dispatch.queries.ts'

// Tenant-scoped, except the reminder scan, which serves every contractor.

// What the homeowner's messages about a job say, and where they go.
export async function findVisit(tenantId: string, jobId: string, tx: Db = db) {
  const [visit] = await tx
    .select({
      contractorName: tenants.name,
      currency: tenants.currency,
      reviewUrl: tenants.reviewUrl,
      customerId: customers.id,
      customerName: customers.name,
      phone: customers.phone,
      email: customers.email,
      serviceName: services.name,
      date: local(jobs.windowStartsAt, 'YYYY-MM-DD'),
      localStart: local(jobs.windowStartsAt, 'HH24:MI:SS'),
      localEnd: local(jobs.windowEndsAt, 'HH24:MI:SS'),
    })
    .from(jobs)
    .innerJoin(tenants, eq(tenants.id, jobs.tenantId))
    .innerJoin(
      customers,
      and(eq(customers.tenantId, jobs.tenantId), eq(customers.id, jobs.customerId)),
    )
    .innerJoin(services, and(eq(services.tenantId, jobs.tenantId), eq(services.id, jobs.serviceId)))
    .where(and(eq(jobs.tenantId, tenantId), eq(jobs.id, jobId)))
  return visit
}

// Booked visits starting in the next `hours` hours whose homeowner can be reached and hasn't
// had a reminder since `hours` before the visit. A visit booked less than `hours` ahead is
// left out: its confirmation was the reminder. A visit moved to a later time gets its
// reminders again, since the old ones were sent before the new time's cut-off.
export function listJobsToRemind(hours: number) {
  const before = sql`${jobs.windowStartsAt} - make_interval(hours => ${hours})`
  return db
    .select({ tenantId: jobs.tenantId, jobId: jobs.id })
    .from(jobs)
    .innerJoin(
      customers,
      and(eq(customers.tenantId, jobs.tenantId), eq(customers.id, jobs.customerId)),
    )
    .where(
      and(
        eq(jobs.status, 'booked'),
        sql`${jobs.windowStartsAt} > now()`,
        sql`now() >= ${before}`,
        sql`${jobs.bookedAt} < ${before}`,
        or(isNotNull(customers.phone), isNotNull(customers.email)),
        notExists(
          db
            .select({ id: messages.id })
            .from(messages)
            .where(
              and(
                eq(messages.tenantId, jobs.tenantId),
                eq(messages.jobId, jobs.id),
                eq(messages.kind, 'reminder'),
                sql`${messages.createdAt} >= ${before}`,
              ),
            ),
        ),
      ),
    )
}
