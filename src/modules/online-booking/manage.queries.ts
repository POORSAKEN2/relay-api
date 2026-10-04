import { and, eq } from 'drizzle-orm'
import { type Db, db } from '../../db/client.ts'
import { customers, jobs, properties, services, tenants } from '../../db/schema.ts'
import { local } from '../dispatch/dispatch.queries.ts'

// Tenant-scoped, like every query: a link only works on its own contractor's address.

// The visit behind a manage link, with what the page and the texts need. Closed jobs have no
// link hash, so they are never found.
export async function findManagedJob(tenantId: string, linkHash: string, tx: Db = db) {
  const [job] = await tx
    .select({
      id: jobs.id,
      status: jobs.status,
      windowStartsAt: jobs.windowStartsAt,
      windowEndsAt: jobs.windowEndsAt,
      date: local(jobs.windowStartsAt, 'YYYY-MM-DD'),
      localStart: local(jobs.windowStartsAt, 'HH24:MI:SS'),
      localEnd: local(jobs.windowEndsAt, 'HH24:MI:SS'),
      serviceName: services.name,
      street: properties.street,
      unit: properties.unit,
      city: properties.city,
      state: properties.state,
      zip: properties.zip,
      customerId: customers.id,
      customerName: customers.name,
      customerPhone: customers.phone,
      customerEmail: customers.email,
    })
    .from(jobs)
    .innerJoin(tenants, eq(tenants.id, jobs.tenantId))
    .innerJoin(services, eq(services.id, jobs.serviceId))
    .innerJoin(properties, eq(properties.id, jobs.propertyId))
    .innerJoin(customers, eq(customers.id, jobs.customerId))
    .where(and(eq(jobs.tenantId, tenantId), eq(jobs.manageLinkHash, linkHash)))
  return job
}
