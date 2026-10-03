import { Router } from 'express'
import { requireRole } from '../../middleware/auth.ts'
import { CreateTenantInput } from './tenants.schemas.ts'
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
