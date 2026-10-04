import { and, desc, eq, exists, inArray, not, or } from 'drizzle-orm'
import { type Db, db, type Tx } from '../../db/client.ts'
import {
  calls,
  customerImports,
  customers,
  jobs,
  messages,
  paymentMethods,
  properties,
  users,
  waitlistEntries,
} from '../../db/schema.ts'
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

// The latest imports, newest first, with the name of who ran each.
export function listImports(tenantId: string, limit: number) {
  return db
    .select({
      id: customerImports.id,
      fileName: customerImports.fileName,
      createdByName: users.name,
      createdCount: customerImports.createdCount,
      skippedCount: customerImports.skippedCount,
      keptCount: customerImports.keptCount,
      createdAt: customerImports.createdAt,
      undoneAt: customerImports.undoneAt,
    })
    .from(customerImports)
    .leftJoin(users, eq(users.id, customerImports.createdBy))
    .where(eq(customerImports.tenantId, tenantId))
    .orderBy(desc(customerImports.createdAt))
    .limit(limit)
}

// Locks the import until the transaction ends, so two undos can't run at once.
export async function lockImport(tenantId: string, importId: string, tx: Tx) {
  const [batch] = await tx
    .select()
    .from(customerImports)
    .where(and(eq(customerImports.tenantId, tenantId), eq(customerImports.id, importId)))
    .for('update')
  return batch
}

// A customer with any history in Relay since the import: a job, call, text, waitlist entry or
// saved card. Undo keeps these.
const hasHistory = or(
  exists(
    db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.tenantId, customers.tenantId), eq(jobs.customerId, customers.id))),
  ),
  exists(
    db
      .select({ id: calls.id })
      .from(calls)
      .where(and(eq(calls.tenantId, customers.tenantId), eq(calls.customerId, customers.id))),
  ),
  exists(
    db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.tenantId, customers.tenantId), eq(messages.customerId, customers.id))),
  ),
  exists(
    db
      .select({ id: waitlistEntries.id })
      .from(waitlistEntries)
      .where(
        and(
          eq(waitlistEntries.tenantId, customers.tenantId),
          eq(waitlistEntries.customerId, customers.id),
        ),
      ),
  ),
  exists(
    db
      .select({ id: paymentMethods.id })
      .from(paymentMethods)
      .where(
        and(
          eq(paymentMethods.tenantId, customers.tenantId),
          eq(paymentMethods.customerId, customers.id),
        ),
      ),
  ),
)!

// Removes the import's customers that have no history, with their addresses. Returns how many.
export async function removeImportedCustomers(tenantId: string, importId: string, tx: Tx) {
  const removable = await tx
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.tenantId, tenantId), eq(customers.importId, importId), not(hasHistory)))
  const ids = removable.map((customer) => customer.id)
  if (ids.length === 0) return 0
  await tx
    .delete(properties)
    .where(and(eq(properties.tenantId, tenantId), inArray(properties.customerId, ids)))
  await tx
    .delete(customers)
    .where(and(eq(customers.tenantId, tenantId), inArray(customers.id, ids)))
  return ids.length
}

export function countImportedCustomers(tenantId: string, importId: string, tx: Tx) {
  return tx.$count(
    customers,
    and(eq(customers.tenantId, tenantId), eq(customers.importId, importId)),
  )
}

export async function markUndone(tenantId: string, importId: string, keptCount: number, tx: Tx) {
  await tx
    .update(customerImports)
    .set({ undoneAt: new Date(), keptCount })
    .where(and(eq(customerImports.tenantId, tenantId), eq(customerImports.id, importId)))
}
