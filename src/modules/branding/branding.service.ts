import { db } from '../../db/client.ts'
import {
  type BRANDING_ASSET_KINDS,
  type BrandingVersion,
  FAVICON_MAX_BYTES,
  LOGO_MAX_BYTES,
  type Tenant,
} from '../../db/schema.ts'
import { HttpError } from '../../lib/http-error.ts'
import { brandingAssetTypeOf, isUnsafeSvg, svgText } from '../../lib/image-type.ts'
import { emitToTenant } from '../../realtime/index.ts'
import * as audit from '../audit/audit.queries.ts'
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

export type AssetKind = (typeof BRANDING_ASSET_KINDS)[number]

const ASSET_COLUMN = { logo: 'logoAssetId', favicon: 'faviconAssetId' } as const
const MAX_BYTES = { logo: LOGO_MAX_BYTES, favicon: FAVICON_MAX_BYTES }
const TOO_LARGE = {
  logo: 'The logo must be 512 KB or smaller.',
  favicon: 'The favicon must be 100 KB or smaller.',
}

// Stores the uploaded file and saves a new version that uses it. `body` is the raw request
// body: a Buffer, or {} when nothing was sent.
export async function setAsset(
  tenantId: string,
  kind: AssetKind,
  body: unknown,
  userId: string,
): Promise<Branding> {
  const tenant = await findTenantOr404(tenantId)
  const data = Buffer.isBuffer(body) ? body : Buffer.alloc(0)
  if (data.length > MAX_BYTES[kind]) throw new HttpError(400, 'image_too_large', TOO_LARGE[kind])
  const contentType = brandingAssetTypeOf(data)
  if (!contentType) throw new HttpError(400, 'unsupported_image', 'Use a PNG or SVG file.')
  if (contentType === 'image/svg+xml' && isUnsafeSvg(svgText(data) ?? '')) {
    throw new HttpError(
      400,
      'unsafe_svg',
      'This SVG has scripts or links in it. Export it again as a plain SVG.',
    )
  }

  const latest = await queries.findLatestBranding(tenantId)
  await db.transaction(async (tx) => {
    const asset = await queries.insertAsset(
      tenantId,
      { kind, contentType, data, createdBy: userId },
      tx,
    )
    await queries.insertBranding(
      tenantId,
      { ...carryOver(latest), [ASSET_COLUMN[kind]]: asset.id, createdBy: userId },
      tx,
    )
    await audit.insertUserAction(
      tenantId,
      {
        actorUserId: userId,
        action: `branding.${kind}_updated`,
        entityType: 'tenant',
        entityId: tenantId,
        data: { assetId: asset.id },
      },
      tx,
    )
  })
  emitToTenant(tenantId, 'branding.updated', { tenantId })
  return getBranding(tenant)
}

// Saves a new version without the logo or favicon. The image itself stays for older versions.
export async function removeAsset(
  tenantId: string,
  kind: AssetKind,
  userId: string,
): Promise<Branding> {
  const tenant = await findTenantOr404(tenantId)
  const latest = await queries.findLatestBranding(tenantId)
  await db.transaction(async (tx) => {
    await queries.insertBranding(
      tenantId,
      { ...carryOver(latest), [ASSET_COLUMN[kind]]: null, createdBy: userId },
      tx,
    )
    await audit.insertUserAction(
      tenantId,
      {
        actorUserId: userId,
        action: `branding.${kind}_removed`,
        entityType: 'tenant',
        entityId: tenantId,
      },
      tx,
    )
  })
  emitToTenant(tenantId, 'branding.updated', { tenantId })
  return getBranding(tenant)
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function getAsset(assetId: string) {
  const asset = UUID.test(assetId) ? await queries.findAsset(assetId) : undefined
  if (!asset) throw new HttpError(404, 'not_found', 'Image not found')
  return asset
}
