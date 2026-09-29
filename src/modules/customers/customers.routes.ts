import { Router } from 'express'
import { z } from 'zod'
import { requireRole } from '../../middleware/auth.ts'
import { tenantOf } from '../booking/booking.service.ts'
import * as customers from './customers.service.ts'

export const customersRoutes = Router()

const SearchQuery = z.object({ q: z.string().trim().max(100).default('') })

customersRoutes.get('/customers', requireRole('owner', 'office'), async (req, res) => {
  const { q } = SearchQuery.parse(req.query)
  res.json({ customers: await customers.search(tenantOf(req.user!), q) })
})
