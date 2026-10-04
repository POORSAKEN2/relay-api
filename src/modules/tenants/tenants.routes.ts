import { Router } from 'express'
import { requireRole } from '../../middleware/auth.ts'
import { TenantParams } from '../branding/branding.schemas.ts'
import { CreateTenantInput, TenantStatusInput } from './tenants.schemas.ts'
import * as tenants from './tenants.service.ts'

export const tenantsRoutes = Router()

const superadmin = requireRole('superadmin')

tenantsRoutes.get('/admin/tenants', superadmin, async (_req, res) => {
  res.json({ tenants: await tenants.listTenants() })
})

tenantsRoutes.post('/admin/tenants', superadmin, async (req, res) => {
  const input = CreateTenantInput.parse(req.body)
  res.status(201).json(await tenants.createTenant(req.user!, input))
})

tenantsRoutes.patch('/admin/tenants/:tenantId/status', superadmin, async (req, res) => {
  const { tenantId } = TenantParams.parse(req.params)
  const { status } = TenantStatusInput.parse(req.body)
  res.json({ tenant: await tenants.setTenantStatus(req.user!, tenantId, status) })
})
