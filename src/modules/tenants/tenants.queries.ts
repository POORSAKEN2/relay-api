import { asc } from 'drizzle-orm'
import { type Db, db } from '../../db/client.ts'
import { tenants, users } from '../../db/schema.ts'

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
