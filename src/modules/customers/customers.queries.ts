import { and, asc, eq, ilike, inArray, or, sql } from 'drizzle-orm'
import { type Db, db } from '../../db/client.ts'
import { customers, properties } from '../../db/schema.ts'

// Tenant-scoped: every query takes tenantId first.

export async function findCustomer(tenantId: string, customerId: string, tx: Db = db) {
  const [customer] = await tx
    .select()
    .from(customers)
    .where(and(eq(customers.tenantId, tenantId), eq(customers.id, customerId)))
  return customer
}

// The customer with this phone number; the oldest one when several share it.
export async function findCustomerByPhone(tenantId: string, phone: string, tx: Db = db) {
  const [customer] = await tx
    .select()
    .from(customers)
    .where(and(eq(customers.tenantId, tenantId), eq(customers.phone, phone)))
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

// Name contains the words, or phone contains the digits. At most `limit` customers, by name.
export async function searchCustomers(
  tenantId: string,
  { name, phoneDigits }: { name: string; phoneDigits: string | null },
  limit: number,
) {
  const matches = [ilike(customers.name, `%${escapeLike(name)}%`)]
  if (phoneDigits) matches.push(ilike(customers.phone, `%${phoneDigits}%`))
  return db
    .select({
      id: customers.id,
      name: customers.name,
      phone: customers.phone,
      email: customers.email,
    })
    .from(customers)
    .where(and(eq(customers.tenantId, tenantId), or(...matches)))
    .orderBy(asc(customers.name))
    .limit(limit)
}

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
    })
    .from(properties)
    .where(and(eq(properties.tenantId, tenantId), inArray(properties.customerId, customerIds)))
    .orderBy(asc(properties.createdAt))
}

// So a typed % or _ matches itself instead of acting as a wildcard.
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}
