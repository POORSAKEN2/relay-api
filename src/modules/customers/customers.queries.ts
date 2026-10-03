import { and, asc, desc, eq, exists, ilike, inArray, notInArray, or, sql } from 'drizzle-orm'
import { type Db, db } from '../../db/client.ts'
import { customers, jobs, properties, services, tenants, users } from '../../db/schema.ts'
import { local } from '../dispatch/dispatch.queries.ts'
import type { CustomerListQuery } from './customers.schemas.ts'

// Tenant-scoped: every query takes tenantId first.

export async function findCustomer(tenantId: string, customerId: string, tx: Db = db) {
  const [customer] = await tx
    .select()
    .from(customers)
    .where(and(eq(customers.tenantId, tenantId), eq(customers.id, customerId)))
  return customer
}

// The customer with this phone number and name; the oldest one when several match. A household
// can share a phone, so the name tells its people apart. Case and extra spaces in the name
// don't count: 'maria  LOPEZ' is 'Maria Lopez'.
export async function findCustomerByPhoneAndName(
  tenantId: string,
  phone: string,
  name: string,
  tx: Db = db,
) {
  const sameName = name.trim().replace(/\s+/g, ' ').toLowerCase()
  const [customer] = await tx
    .select()
    .from(customers)
    .where(
      and(
        eq(customers.tenantId, tenantId),
        eq(customers.phone, phone),
        sql`lower(regexp_replace(btrim(${customers.name}), '\\s+', ' ', 'g')) = ${sameName}`,
      ),
    )
    .orderBy(asc(customers.createdAt))
    .limit(1)
  return customer
}

export async function insertCustomer(
  tenantId: string,
  values: Omit<typeof customers.$inferInsert, 'tenantId'>,
  tx: Db = db,
) {
  const [customer] = await tx
    .insert(customers)
    .values({ ...values, tenantId })
    .returning()
  return customer
}

export async function findProperty(
  tenantId: string,
  customerId: string,
  propertyId: string,
  tx: Db = db,
) {
  const [property] = await tx
    .select()
    .from(properties)
    .where(
      and(
        eq(properties.tenantId, tenantId),
        eq(properties.customerId, customerId),
        eq(properties.id, propertyId),
      ),
    )
  return property
}

// The customer's saved address on this street in this ZIP code, whatever the letter case.
export async function findPropertyAt(
  tenantId: string,
  customerId: string,
  { street, zip }: { street: string; zip: string },
  tx: Db = db,
) {
  const [property] = await tx
    .select()
    .from(properties)
    .where(
      and(
        eq(properties.tenantId, tenantId),
        eq(properties.customerId, customerId),
        eq(properties.zip, zip),
        sql`lower(${properties.street}) = lower(${street})`,
      ),
    )
    .orderBy(asc(properties.createdAt))
    .limit(1)
  return property
}

export async function insertProperty(
  tenantId: string,
  values: Omit<typeof properties.$inferInsert, 'tenantId'>,
  tx: Db = db,
) {
  const [property] = await tx
    .insert(properties)
    .values({ ...values, tenantId })
    .returning()
  return property
}

// Every address of these customers, oldest first, with equipment and access notes.
export function listProperties(tenantId: string, customerIds: string[]) {
  if (customerIds.length === 0) return Promise.resolve([])
  return db
    .select({
      id: properties.id,
      customerId: properties.customerId,
      street: properties.street,
      unit: properties.unit,
      city: properties.city,
      state: properties.state,
      zip: properties.zip,
      equipmentBrand: properties.equipmentBrand,
      equipmentYear: properties.equipmentYear,
      notes: properties.notes,
    })
    .from(properties)
    .where(and(eq(properties.tenantId, tenantId), inArray(properties.customerId, customerIds)))
    .orderBy(asc(properties.createdAt))
}

// A job that is still going to happen: booked or under way, and its arrival window hasn't
// ended. The one rule for "upcoming": the list's next visit and the record's Upcoming jobs.
export const isUpcoming = sql<boolean>`(${jobs.status} in ('booked', 'en_route', 'in_progress') and ${jobs.windowEndsAt} > now())`

// One page of customers: matching the search, by name or newest first, with the local day of
// their next upcoming visit and of their last finished one. Also counts every match.
export async function listCustomers(
  tenantId: string,
  { q, sort, page }: CustomerListQuery,
  pageSize: number,
) {
  const where = and(eq(customers.tenantId, tenantId), matching(q))
  const rows = await db
    .select({
      id: customers.id,
      name: customers.name,
      phone: customers.phone,
      email: customers.email,
      lastVisitDate: sql<string | null>`(
        select to_char(max(${jobs.completedAt}) at time zone ${tenants.timezone}, 'YYYY-MM-DD')
        from ${jobs}
        where ${jobs.customerId} = ${customers.id} and ${jobs.status} = 'done'
      )`,
      nextVisitDate: sql<string | null>`(
        select to_char(min(${jobs.windowStartsAt}) at time zone ${tenants.timezone}, 'YYYY-MM-DD')
        from ${jobs}
        where ${jobs.customerId} = ${customers.id} and ${isUpcoming}
      )`,
    })
    .from(customers)
    .innerJoin(tenants, eq(tenants.id, customers.tenantId))
    .where(where)
    .orderBy(
      ...(sort === 'newest'
        ? [desc(customers.createdAt), desc(customers.id)]
        : [asc(customers.name), asc(customers.id)]),
    )
    .limit(pageSize)
    .offset((page - 1) * pageSize)
  const total = await db.$count(customers, where)
  return { rows, total }
}

// A customer's jobs on their record: everything but abandoned booking attempts.
function inHistory(tenantId: string, customerId: string) {
  return and(
    eq(jobs.tenantId, tenantId),
    eq(jobs.customerId, customerId),
    notInArray(jobs.status, ['held', 'expired']),
  )
}

// The customer's newest `limit` jobs, newest first, with local day and window times.
export function listJobHistory(tenantId: string, customerId: string, limit: number) {
  return db
    .select({
      id: jobs.id,
      status: jobs.status,
      upcoming: isUpcoming,
      propertyId: jobs.propertyId,
      date: local(jobs.windowStartsAt, 'YYYY-MM-DD'),
      localStart: local(jobs.windowStartsAt, 'HH24:MI:SS'),
      localEnd: local(jobs.windowEndsAt, 'HH24:MI:SS'),
      serviceName: services.name,
      problem: jobs.problem,
      technicianName: users.name,
    })
    .from(jobs)
    .innerJoin(tenants, eq(tenants.id, jobs.tenantId))
    .innerJoin(services, eq(services.id, jobs.serviceId))
    .leftJoin(users, eq(users.id, jobs.technicianId))
    .where(inHistory(tenantId, customerId))
    .orderBy(desc(jobs.windowStartsAt))
    .limit(limit)
}

export function countJobHistory(tenantId: string, customerId: string) {
  return db.$count(jobs, inHistory(tenantId, customerId))
}

// Name, email or one of their streets contains the text, or the phone contains its digits
// (3 or more). An empty search matches everyone.
function matching(q: string) {
  if (q === '') return undefined
  const text = `%${escapeLike(q)}%`
  const digits = q.replace(/\D/g, '')
  return or(
    ilike(customers.name, text),
    ilike(customers.email, text),
    exists(
      db
        .select({ id: properties.id })
        .from(properties)
        .where(and(eq(properties.customerId, customers.id), ilike(properties.street, text))),
    ),
    digits.length >= 3 ? ilike(customers.phone, `%${digits}%`) : undefined,
  )
}

// So a typed % or _ matches itself instead of acting as a wildcard.
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}
