import { and, asc, eq } from 'drizzle-orm'
import { type Db, db, type Tx } from '../../db/client.ts'
import { serviceAreaZips, tenants } from '../../db/schema.ts'

// Tenant-scoped: every query takes tenantId first.

export async function findPriorityFee(tenantId: string) {
  const [tenant] = await db
    .select({ priorityFeeCents: tenants.priorityFeeCents })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
  return tenant.priorityFeeCents
}

export async function setPriorityFee(tenantId: string, priorityFeeCents: number) {
  await db.update(tenants).set({ priorityFeeCents }).where(eq(tenants.id, tenantId))
}

export async function listZips(tenantId: string, tx: Db = db) {
  const rows = await tx
    .select({ zip: serviceAreaZips.zip })
    .from(serviceAreaZips)
    .where(eq(serviceAreaZips.tenantId, tenantId))
    .orderBy(asc(serviceAreaZips.zip))
  return rows.map((row) => row.zip)
}

export async function zipIsServed(tenantId: string, zip: string, tx: Db = db) {
  const [row] = await tx
    .select({ zip: serviceAreaZips.zip })
    .from(serviceAreaZips)
    .where(and(eq(serviceAreaZips.tenantId, tenantId), eq(serviceAreaZips.zip, zip)))
  return Boolean(row)
}

// Swaps the contractor's whole list for `zips`.
export async function replaceZips(tenantId: string, zips: string[], tx: Tx) {
  await tx.delete(serviceAreaZips).where(eq(serviceAreaZips.tenantId, tenantId))
  if (zips.length > 0) {
    await tx.insert(serviceAreaZips).values(zips.map((zip) => ({ tenantId, zip })))
  }
}
