import { Router } from 'express'
import { requireRole } from '../../middleware/auth.ts'
import { tenantOf } from '../booking/booking.service.ts'
import { ServiceInput, ServiceOrderInput, ServiceParams } from './catalog.schemas.ts'
import * as catalog from './catalog.service.ts'

export const catalogRoutes = Router()

const staff = requireRole('owner', 'office')

// Every service, archived ones too. Booking's own list (GET /services) has only active ones.
catalogRoutes.get('/services/all', staff, async (req, res) => {
  res.json({ services: await catalog.list(tenantOf(req.user!)) })
})

catalogRoutes.post('/services', staff, async (req, res) => {
  const input = ServiceInput.parse(req.body)
  res.status(201).json({ service: await catalog.add(req.user!, input) })
})

catalogRoutes.put('/services/order', staff, async (req, res) => {
  const { ids } = ServiceOrderInput.parse(req.body)
  res.json({ services: await catalog.reorder(req.user!, ids) })
})

catalogRoutes.patch('/services/:serviceId', staff, async (req, res) => {
  const { serviceId } = ServiceParams.parse(req.params)
  const input = ServiceInput.parse(req.body)
  res.json({ service: await catalog.update(req.user!, serviceId, input) })
})

catalogRoutes.post('/services/:serviceId/archive', staff, async (req, res) => {
  const { serviceId } = ServiceParams.parse(req.params)
  res.json({ service: await catalog.archive(req.user!, serviceId) })
})

catalogRoutes.post('/services/:serviceId/restore', staff, async (req, res) => {
  const { serviceId } = ServiceParams.parse(req.params)
  res.json({ service: await catalog.restore(req.user!, serviceId) })
})
