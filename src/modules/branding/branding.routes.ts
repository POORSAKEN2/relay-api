import express, { type Response, Router } from 'express'
import { BRANDING_ASSET_KINDS } from '../../db/schema.ts'
import { requireRole } from '../../middleware/auth.ts'
import { tenantFromHost } from '../../middleware/tenant.ts'
import { BrandingInput, TenantParams, VersionParams } from './branding.schemas.ts'
import * as branding from './branding.service.ts'

export const brandingRoutes = Router()

brandingRoutes.get('/branding', tenantFromHost, async (req, res) => {
  res.json(await branding.getBranding(req.tenant!))
})

brandingRoutes.get(
  '/admin/tenants/:tenantId/branding',
  requireRole('superadmin'),
  async (req, res) => {
    const { tenantId } = TenantParams.parse(req.params)
    res.json(await branding.getBrandingByTenantId(tenantId))
  },
)

brandingRoutes.put(
  '/admin/tenants/:tenantId/branding',
  requireRole('superadmin'),
  async (req, res) => {
    const { tenantId } = TenantParams.parse(req.params)
    const input = BrandingInput.parse(req.body)
    res.json(await branding.updateBranding(tenantId, input, req.user!.id))
  },
)

brandingRoutes.get(
  '/admin/tenants/:tenantId/branding/versions',
  requireRole('superadmin'),
  async (req, res) => {
    const { tenantId } = TenantParams.parse(req.params)
    res.json({ versions: await branding.listVersions(tenantId) })
  },
)

brandingRoutes.post(
  '/admin/tenants/:tenantId/branding/versions/:versionId/restore',
  requireRole('superadmin'),
  async (req, res) => {
    const { tenantId, versionId } = VersionParams.parse(req.params)
    res.json(await branding.restoreVersion(tenantId, versionId, req.user!.id))
  },
)

// The image is the request body itself, not JSON. The service checks its type and size.
const assetBody = express.raw({ type: () => true, limit: '1mb' })

for (const kind of BRANDING_ASSET_KINDS) {
  brandingRoutes.put(
    `/admin/tenants/:tenantId/branding/${kind}`,
    requireRole('superadmin'),
    assetBody,
    async (req, res) => {
      const { tenantId } = TenantParams.parse(req.params)
      res.json(await branding.setAsset(tenantId, kind, req.body, req.user!.id))
    },
  )

  brandingRoutes.delete(
    `/admin/tenants/:tenantId/branding/${kind}`,
    requireRole('superadmin'),
    async (req, res) => {
      const { tenantId } = TenantParams.parse(req.params)
      res.json(await branding.removeAsset(tenantId, kind, req.user!.id))
    },
  )
}

// Public: <img> and favicon requests can't send a session or X-Tenant-Host. The sandbox
// policy means an SVG opened directly can't run or load anything.
brandingRoutes.get('/branding/assets/:assetId', async (req, res) => {
  sendAsset(res, await branding.getAsset(req.params.assetId))
})

function sendAsset(res: Response, asset: { contentType: string; data: Buffer }) {
  res
    .set({
      'Content-Type': asset.contentType,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    })
    .send(asset.data)
}
