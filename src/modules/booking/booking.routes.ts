import { Router } from 'express'
import { requireRole } from '../../middleware/auth.ts'
import { OfficeBookingInput } from './booking.schemas.ts'
import * as booking from './booking.service.ts'

export const bookingRoutes = Router()

const staff = requireRole('owner', 'office')

bookingRoutes.get('/services', staff, async (req, res) => {
  res.json({ services: await booking.listServices(booking.tenantOf(req.user!)) })
})

bookingRoutes.post('/bookings', staff, async (req, res) => {
  const input = OfficeBookingInput.parse(req.body)
  res.status(201).json(await booking.bookForOffice(req.user!, input))
})
