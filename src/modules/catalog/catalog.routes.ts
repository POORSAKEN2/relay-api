import { Router } from 'express'
import { requireRole } from '../../middleware/auth.ts'
import { tenantOf } from '../booking/booking.service.ts'
import {
  PriceItemInput,
  PriceItemParams,
  ServiceInput,
  ServiceOrderInput,
  ServiceParams,
} from './catalog.schemas.ts'
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

// The repair price list, archived prices too. Technicians get only the active ones
// (GET /my-jobs/price-items).
catalogRoutes.get('/price-items', staff, async (req, res) => {
  res.json({ priceItems: await catalog.listPriceItems(tenantOf(req.user!)) })
})

catalogRoutes.post('/price-items', staff, async (req, res) => {
  const input = PriceItemInput.parse(req.body)
  res.status(201).json({ priceItem: await catalog.addPriceItem(req.user!, input) })
})

catalogRoutes.patch('/price-items/:priceItemId', staff, async (req, res) => {
  const { priceItemId } = PriceItemParams.parse(req.params)
  const input = PriceItemInput.parse(req.body)
  res.json({ priceItem: await catalog.updatePriceItem(req.user!, priceItemId, input) })
})

catalogRoutes.post('/price-items/:priceItemId/archive', staff, async (req, res) => {
  const { priceItemId } = PriceItemParams.parse(req.params)
  res.json({ priceItem: await catalog.archivePriceItem(req.user!, priceItemId) })
})

catalogRoutes.post('/price-items/:priceItemId/restore', staff, async (req, res) => {
  const { priceItemId } = PriceItemParams.parse(req.params)
  res.json({ priceItem: await catalog.restorePriceItem(req.user!, priceItemId) })
})
