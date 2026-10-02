import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import { type Db, db, type Tx } from '../../db/client.ts'
import { priceItems, services } from '../../db/schema.ts'

// Tenant-scoped: every query takes tenantId first.

const columns = {
  id: services.id,
  name: services.name,
  description: services.description,
  priceType: services.priceType,
  priceCents: services.priceCents,
  archivedAt: services.archivedAt,
}

const isServiceOf = (tenantId: string, serviceId: string) =>
  and(eq(services.tenantId, tenantId), eq(services.id, serviceId))

// One past the contractor's last service.
const endOfList = (tenantId: string) =>
  sql<number>`(select coalesce(max(s.sort_order), -1) + 1 from services s where s.tenant_id = ${tenantId})`

// Active services in booking order, then archived ones.
export function listServices(tenantId: string, tx: Db = db) {
  return tx
    .select(columns)
    .from(services)
    .where(eq(services.tenantId, tenantId))
    .orderBy(sql`${services.archivedAt} is not null`, asc(services.sortOrder), asc(services.name))
}

export async function findService(tenantId: string, serviceId: string) {
  const [service] = await db.select(columns).from(services).where(isServiceOf(tenantId, serviceId))
  return service
}

type ServiceValues = Pick<
  typeof services.$inferInsert,
  'name' | 'description' | 'priceType' | 'priceCents'
>

export async function insertService(tenantId: string, values: ServiceValues) {
  const [service] = await db
    .insert(services)
    .values({ ...values, tenantId, sortOrder: endOfList(tenantId) })
    .returning(columns)
  return service
}

// Returns the service when it was found (and updated), undefined otherwise.
export async function updateService(tenantId: string, serviceId: string, values: ServiceValues) {
  const [service] = await db
    .update(services)
    .set(values)
    .where(isServiceOf(tenantId, serviceId))
    .returning(columns)
  return service
}

// Returns the service only when this call archived it.
export async function archiveService(tenantId: string, serviceId: string) {
  const [service] = await db
    .update(services)
    .set({ archivedAt: new Date() })
    .where(and(isServiceOf(tenantId, serviceId), isNull(services.archivedAt)))
    .returning(columns)
  return service
}

// Back on booking, after the services already there. Returns the service only when this
// call restored it.
export async function restoreService(tenantId: string, serviceId: string) {
  const [service] = await db
    .update(services)
    .set({ archivedAt: null, sortOrder: endOfList(tenantId) })
    .where(and(isServiceOf(tenantId, serviceId), isNotNull(services.archivedAt)))
    .returning(columns)
  return service
}

// Locks the contractor's active services until the transaction ends.
export async function lockActiveServiceIds(tenantId: string, tx: Tx) {
  const rows = await tx
    .select({ id: services.id })
    .from(services)
    .where(and(eq(services.tenantId, tenantId), isNull(services.archivedAt)))
    .for('update')
  return rows.map((row) => row.id)
}

export async function setSortOrder(tenantId: string, serviceId: string, sortOrder: number, tx: Tx) {
  await tx.update(services).set({ sortOrder }).where(isServiceOf(tenantId, serviceId))
}

const priceColumns = {
  id: priceItems.id,
  name: priceItems.name,
  priceCents: priceItems.priceCents,
  archivedAt: priceItems.archivedAt,
}

const isPriceItemOf = (tenantId: string, priceItemId: string) =>
  and(eq(priceItems.tenantId, tenantId), eq(priceItems.id, priceItemId))

// Active prices first, then archived ones, each by name.
export function listPriceItems(tenantId: string) {
  return db
    .select(priceColumns)
    .from(priceItems)
    .where(eq(priceItems.tenantId, tenantId))
    .orderBy(sql`${priceItems.archivedAt} is not null`, asc(priceItems.name))
}

// What a technician can add to a job: active prices by name.
export function listActivePriceItems(tenantId: string) {
  return db
    .select({ id: priceItems.id, name: priceItems.name, priceCents: priceItems.priceCents })
    .from(priceItems)
    .where(and(eq(priceItems.tenantId, tenantId), isNull(priceItems.archivedAt)))
    .orderBy(asc(priceItems.name))
}

export async function findPriceItem(tenantId: string, priceItemId: string) {
  const [item] = await db
    .select(priceColumns)
    .from(priceItems)
    .where(isPriceItemOf(tenantId, priceItemId))
  return item
}

type PriceItemValues = Pick<typeof priceItems.$inferInsert, 'name' | 'priceCents'>

export async function insertPriceItem(tenantId: string, values: PriceItemValues) {
  const [item] = await db
    .insert(priceItems)
    .values({ ...values, tenantId })
    .returning(priceColumns)
  return item
}

// Returns the price when it was found (and updated), undefined otherwise.
export async function updatePriceItem(
  tenantId: string,
  priceItemId: string,
  values: PriceItemValues,
) {
  const [item] = await db
    .update(priceItems)
    .set(values)
    .where(isPriceItemOf(tenantId, priceItemId))
    .returning(priceColumns)
  return item
}

// Returns the price only when this call archived it.
export async function archivePriceItem(tenantId: string, priceItemId: string) {
  const [item] = await db
    .update(priceItems)
    .set({ archivedAt: new Date() })
    .where(and(isPriceItemOf(tenantId, priceItemId), isNull(priceItems.archivedAt)))
    .returning(priceColumns)
  return item
}

// Returns the price only when this call restored it.
export async function restorePriceItem(tenantId: string, priceItemId: string) {
  const [item] = await db
    .update(priceItems)
    .set({ archivedAt: null })
    .where(and(isPriceItemOf(tenantId, priceItemId), isNotNull(priceItems.archivedAt)))
    .returning(priceColumns)
  return item
}
