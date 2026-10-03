import { Router } from 'express'
import { requireRole } from '../../middleware/auth.ts'
import { tenantOf } from '../booking/booking.service.ts'
import {
  CustomerChanges,
  CustomerListQuery,
  CustomerParams,
  NewCustomerInput,
  PropertyInput,
  PropertyParams,
} from './customers.schemas.ts'
import * as customers from './customers.service.ts'

export const customersRoutes = Router()

const staff = requireRole('owner', 'office')

customersRoutes.get('/customers', staff, async (req, res) => {
  const query = CustomerListQuery.parse(req.query)
  res.json(await customers.list(tenantOf(req.user!), query))
})

customersRoutes.post('/customers', staff, async (req, res) => {
  const input = NewCustomerInput.parse(req.body)
  res.status(201).json(await customers.create(tenantOf(req.user!), input))
})

customersRoutes.get('/customers/:customerId', staff, async (req, res) => {
  const { customerId } = CustomerParams.parse(req.params)
  res.json(await customers.detail(tenantOf(req.user!), customerId))
})

customersRoutes.patch('/customers/:customerId', staff, async (req, res) => {
  const { customerId } = CustomerParams.parse(req.params)
  const changes = CustomerChanges.parse(req.body)
  res.json(await customers.update(tenantOf(req.user!), customerId, changes))
})

customersRoutes.post('/customers/:customerId/properties', staff, async (req, res) => {
  const { customerId } = CustomerParams.parse(req.params)
  const input = PropertyInput.parse(req.body)
  res.status(201).json(await customers.addProperty(tenantOf(req.user!), customerId, input))
})

customersRoutes.put('/customers/:customerId/properties/:propertyId', staff, async (req, res) => {
  const { customerId, propertyId } = PropertyParams.parse(req.params)
  const input = PropertyInput.parse(req.body)
  res.json(await customers.replaceProperty(tenantOf(req.user!), customerId, propertyId, input))
})
