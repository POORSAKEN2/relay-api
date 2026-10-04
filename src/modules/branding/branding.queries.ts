import { and, desc, eq } from 'drizzle-orm'
import { type Db, db } from '../../db/client.ts'
import {
  type BrandingVersion,
  brandingAssets,
  brandingVersions,
  type Tenant,
  tenants,
  users,
} from '../../db/schema.ts'

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
  tx: Db = db,
) {
  await tx.insert(brandingVersions).values({ ...values, tenantId })
}

export async function insertAsset(
  tenantId: string,
  values: Omit<typeof brandingAssets.$inferInsert, 'tenantId' | 'id' | 'createdAt'>,
  tx: Db,
) {
  const [asset] = await tx
    .insert(brandingAssets)
    .values({ ...values, tenantId })
    .returning({ id: brandingAssets.id })
  return asset
}

// Not tenant-scoped: images are public, found by their random id.
export async function findAsset(id: string) {
  const [asset] = await db
    .select({ contentType: brandingAssets.contentType, data: brandingAssets.data })
    .from(brandingAssets)
    .where(eq(brandingAssets.id, id))
    .limit(1)
  return asset
}

export async function listVersions(tenantId: string, limit: number) {
  return db
    .select({
      id: brandingVersions.id,
      primaryColor: brandingVersions.primaryColor,
      accentColor: brandingVersions.accentColor,
      logoAssetId: brandingVersions.logoAssetId,
      faviconAssetId: brandingVersions.faviconAssetId,
      createdAt: brandingVersions.createdAt,
      createdByName: users.name,
    })
    .from(brandingVersions)
    .innerJoin(users, eq(users.id, brandingVersions.createdBy))
    .where(eq(brandingVersions.tenantId, tenantId))
    .orderBy(desc(brandingVersions.createdAt))
    .limit(limit)
}

export async function findVersion(
  tenantId: string,
  versionId: string,
): Promise<BrandingVersion | undefined> {
  const [version] = await db
    .select()
    .from(brandingVersions)
    .where(and(eq(brandingVersions.tenantId, tenantId), eq(brandingVersions.id, versionId)))
    .limit(1)
  return version
}
