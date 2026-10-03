import { Router } from 'express'
import { requireRole } from '../../middleware/auth.ts'
import { tenantFromHost } from '../../middleware/tenant.ts'
import { BrandingInput, TenantParams } from './branding.schemas.ts'
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
