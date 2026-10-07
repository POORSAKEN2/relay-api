import { Router } from 'express'
import { requireRole } from '../../middleware/auth.ts'
import { tenantOf } from '../booking/booking.service.ts'
import { PriorityFeeInput, ServiceAreaInput } from './settings.schemas.ts'
import * as settings from './settings.service.ts'

export const settingsRoutes = Router()

const staff = requireRole('owner', 'office')

settingsRoutes.get('/settings/booking', staff, async (req, res) => {
  res.json(await settings.getBookingSettings(tenantOf(req.user!)))
})

settingsRoutes.get('/settings/booking-links', staff, async (req, res) => {
  res.json(await settings.getBookingLinks(tenantOf(req.user!)))
})

settingsRoutes.put('/settings/priority-fee', staff, async (req, res) => {
  const { priorityFeeCents } = PriorityFeeInput.parse(req.body)
  res.json(await settings.setPriorityFee(req.user!, priorityFeeCents))
})

settingsRoutes.put('/settings/service-area', staff, async (req, res) => {
  const { zips } = ServiceAreaInput.parse(req.body)
  res.json(await settings.setServiceArea(req.user!, zips))
})
