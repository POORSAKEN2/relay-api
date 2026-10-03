import type { BrandingVersion, Tenant } from '../../db/schema.ts'
import { HttpError } from '../../lib/http-error.ts'
import { emitToTenant } from '../../realtime/index.ts'
import * as queries from './branding.queries.ts'
import type { BrandingInput } from './branding.schemas.ts'

// Colors a contractor has until the superadmin sets theirs.
export const DEFAULT_COLORS = { primaryColor: '#1d4ed8', accentColor: '#0ea5e9' }

export type Branding = {
  name: string
  slug: string
  primaryColor: string
  accentColor: string
  logoUrl: string | null
  faviconUrl: string | null
}

// Where the web app loads an image from: a path under the API, like a technician's photoUrl.
export function assetPath(id: string | null | undefined): string | null {
  return id ? `/branding/assets/${id}` : null
}

export async function getBranding(tenant: Tenant): Promise<Branding> {
  const latest = await queries.findLatestBranding(tenant.id)
  return {
    name: tenant.name,
    slug: tenant.slug,
    primaryColor: latest?.primaryColor ?? DEFAULT_COLORS.primaryColor,
    accentColor: latest?.accentColor ?? DEFAULT_COLORS.accentColor,
    logoUrl: assetPath(latest?.logoAssetId),
    faviconUrl: assetPath(latest?.faviconAssetId),
  }
}

// Everything the latest version has, so a new version changes only what it means to.
export function carryOver(latest: BrandingVersion | undefined) {
  return {
    primaryColor: latest?.primaryColor ?? DEFAULT_COLORS.primaryColor,
    accentColor: latest?.accentColor ?? DEFAULT_COLORS.accentColor,
    logoAssetId: latest?.logoAssetId ?? null,
    faviconAssetId: latest?.faviconAssetId ?? null,
  }
}

export async function getBrandingByTenantId(tenantId: string): Promise<Branding> {
  return getBranding(await findTenantOr404(tenantId))
}

// Saves a new version (older ones stay for history and revert) and tells open dashboards.
export async function updateBranding(
  tenantId: string,
  input: BrandingInput,
  userId: string,
): Promise<Branding> {
  const tenant = await findTenantOr404(tenantId)
  const current = await queries.findLatestBranding(tenantId)
  await queries.insertBranding(tenantId, { ...carryOver(current), ...input, createdBy: userId })
  emitToTenant(tenantId, 'branding.updated', { tenantId })
  return getBranding(tenant)
}

export async function findTenantOr404(tenantId: string): Promise<Tenant> {
  const tenant = await queries.findTenantById(tenantId)
  if (!tenant) throw new HttpError(404, 'not_found', 'Contractor not found')
  return tenant
}
