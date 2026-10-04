import { asc, eq, inArray } from 'drizzle-orm'
import { type Db, db } from '../../db/client.ts'
import { sessions, tenants, users } from '../../db/schema.ts'
import type { TenantStatus } from './tenants.schemas.ts'

// Platform-level: the superadmin manages every contractor, so these are not tenant-scoped.

// What the admin page shows for each contractor.
export const tenantColumns = {
  id: tenants.id,
  slug: tenants.slug,
  name: tenants.name,
  status: tenants.status,
  contactEmail: tenants.contactEmail,
  contactPhone: tenants.contactPhone,
  createdAt: tenants.createdAt,
}

export function listTenants() {
  return db.select(tenantColumns).from(tenants).orderBy(asc(tenants.name))
}

export async function insertTenant(
  values: Pick<
    typeof tenants.$inferInsert,
    'name' | 'slug' | 'timezone' | 'contactEmail' | 'contactPhone'
  >,
  tx: Db,
) {
  const [tenant] = await tx.insert(tenants).values(values).returning(tenantColumns)
  return tenant
}

export async function insertOwner(
  values: { tenantId: string; name: string; email: string; passwordHash: string },
  tx: Db,
) {
  const [owner] = await tx
    .insert(users)
    .values({ ...values, role: 'owner' })
    .returning({ id: users.id, name: users.name, email: users.email })
  return owner
}

// Locks the row so two status changes at once are recorded in order.
export async function findTenantStatusForUpdate(tenantId: string, tx: Db) {
  const [tenant] = await tx
    .select({ status: tenants.status })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .for('update')
  return tenant
}

export async function updateTenantStatus(tenantId: string, status: TenantStatus, tx: Db) {
  const [tenant] = await tx
    .update(tenants)
    .set({ status })
    .where(eq(tenants.id, tenantId))
    .returning(tenantColumns)
  return tenant
}

// Signs out everyone at one contractor.
export async function deleteTenantSessions(tenantId: string, tx: Db) {
  await tx
    .delete(sessions)
    .where(
      inArray(
        sessions.userId,
        tx.select({ id: users.id }).from(users).where(eq(users.tenantId, tenantId)),
      ),
    )
}
