import { and, eq, inArray } from 'drizzle-orm'
import type { Db } from '../../db/client.ts'
import { customerImports, customers, properties } from '../../db/schema.ts'
import type { ReadyRow } from './import-rows.ts'

// Tenant-scoped: every query takes tenantId first.

// Rows go in 500 at a time, well under Postgres's limit on query parameters.
const CHUNK = 500

// This contractor's customers with any of these phone numbers, to spot ones already in Relay.
export function listCustomersByPhones(tenantId: string, phones: string[], tx: Db) {
  if (phones.length === 0) return Promise.resolve([])
  return tx
    .select({ phone: customers.phone, name: customers.name })
    .from(customers)
    .where(and(eq(customers.tenantId, tenantId), inArray(customers.phone, phones)))
}

export async function insertImport(
  tenantId: string,
  values: Omit<typeof customerImports.$inferInsert, 'tenantId'>,
  tx: Db,
) {
  const [batch] = await tx
    .insert(customerImports)
    .values({ ...values, tenantId })
    .returning()
  return batch
}

// Saves the ready rows as customers of this import, with their addresses.
export async function insertImportedCustomers(
  tenantId: string,
  importId: string,
  rows: ReadyRow[],
  tx: Db,
) {
  for (let start = 0; start < rows.length; start += CHUNK) {
    const chunk = rows.slice(start, start + CHUNK)
    // Postgres returns the inserted rows in the order of VALUES, so ids line up with the chunk.
    const inserted = await tx
      .insert(customers)
      .values(
        chunk.map(({ customer }) => ({
          ...customer,
          tenantId,
          importId,
          source: 'import' as const,
        })),
      )
      .returning({ id: customers.id })
    const addresses = chunk.flatMap(({ property }, index) =>
      property ? [{ ...property, tenantId, customerId: inserted[index]!.id }] : [],
    )
    if (addresses.length > 0) await tx.insert(properties).values(addresses)
  }
}
