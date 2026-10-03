import { Router } from 'express'
import { requireRole } from '../../middleware/auth.ts'
import { tenantOf } from '../booking/booking.service.ts'
import { CustomerListQuery } from './customers.schemas.ts'
import * as customers from './customers.service.ts'

export const customersRoutes = Router()

const staff = requireRole('owner', 'office')

customersRoutes.get('/customers', staff, async (req, res) => {
  const query = CustomerListQuery.parse(req.query)
  res.json(await customers.list(tenantOf(req.user!), query))
})
