import { desc, eq } from 'drizzle-orm'
import { db } from '../../db/client.ts'
import { type BrandingVersion, brandingVersions, type Tenant, tenants } from '../../db/schema.ts'

export type TenantHost = { slug: string } | { customDomain: string }

// Tenant lookups run before a contractor is known, so they are not tenant-scoped.

export async function findTenantByHost(host: TenantHost): Promise<Tenant | undefined> {
  const where =
    'slug' in host ? eq(tenants.slug, host.slug) : eq(tenants.customDomain, host.customDomain)
  const [tenant] = await db.select().from(tenants).where(where).limit(1)
  return tenant
}

export async function findTenantById(id: string): Promise<Tenant | undefined> {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, id)).limit(1)
  return tenant
}

// Tenant-scoped: every query below takes tenantId first.

export async function findLatestBranding(tenantId: string): Promise<BrandingVersion | undefined> {
  const [latest] = await db
    .select()
    .from(brandingVersions)
    .where(eq(brandingVersions.tenantId, tenantId))
    .orderBy(desc(brandingVersions.createdAt))
    .limit(1)
  return latest
}

export async function insertBranding(
  tenantId: string,
  values: Omit<typeof brandingVersions.$inferInsert, 'tenantId'>,
) {
  await db.insert(brandingVersions).values({ ...values, tenantId })
}
