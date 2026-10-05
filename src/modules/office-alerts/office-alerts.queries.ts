import { and, asc, eq, inArray, isNotNull, isNull, ne } from 'drizzle-orm'
import { type Db, db } from '../../db/client.ts'
import { type JobSource, jobs, properties, services, tenants, users } from '../../db/schema.ts'
import { local } from '../dispatch/dispatch.queries.ts'

// Details of a newly booked job needed to write and link the office alert.
export async function findAlertJob(tenantId: string, jobId: string, tx: Db = db) {
  const [job] = await tx
    .select({
      contractorName: tenants.name,
      tenant: {
        slug: tenants.slug,
        customDomain: tenants.customDomain,
        customDomainVerifiedAt: tenants.customDomainVerifiedAt,
      },
      serviceName: services.name,
      city: properties.city,
      date: local(jobs.windowStartsAt, 'YYYY-MM-DD'),
      localStart: local(jobs.windowStartsAt, 'HH24:MI:SS'),
      localEnd: local(jobs.windowEndsAt, 'HH24:MI:SS'),
      source: jobs.source,
      priority: jobs.priority,
      vulnerableOccupant: jobs.vulnerableOccupant,
      createdBy: jobs.createdBy,
    })
    .from(jobs)
    .innerJoin(tenants, eq(tenants.id, jobs.tenantId))
    .innerJoin(properties, eq(properties.id, jobs.propertyId))
    .innerJoin(services, eq(services.id, jobs.serviceId))
    .where(and(eq(jobs.tenantId, tenantId), eq(jobs.id, jobId)))
  return job as {
    contractorName: string
    tenant: { slug: string; customDomain: string | null; customDomainVerifiedAt: Date | null }
    serviceName: string
    city: string
    date: string
    localStart: string
    localEnd: string
    source: JobSource
    priority: boolean
    vulnerableOccupant: boolean
    createdBy: string | null
  }
}

// Active owner and office users with a mobile number, skipping the booker when known.
export async function listAlertRecipients(
  tenantId: string,
  exceptUserId: string | null,
  tx: Db = db,
): Promise<{ id: string; phone: string }[]> {
  const conditions = [
    eq(users.tenantId, tenantId),
    inArray(users.role, ['owner', 'office']),
    isNull(users.disabledAt),
    isNotNull(users.phone),
  ]
  if (exceptUserId) {
    conditions.push(ne(users.id, exceptUserId))
  }
  const rows = await tx
    .select({ id: users.id, phone: users.phone })
    .from(users)
    .where(and(...conditions))
    .orderBy(asc(users.name))

  return rows.map((r) => ({ id: r.id, phone: r.phone! }))
}
