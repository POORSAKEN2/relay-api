import { Router } from 'express'
import { requireRole } from '../../middleware/auth.ts'
import { tenantOf } from '../booking/booking.service.ts'
import { StaffInput, StaffParams } from './staff.schemas.ts'
import * as staff from './staff.service.ts'

export const staffRoutes = Router()

const officeOrOwner = requireRole('owner', 'office')

staffRoutes.get('/staff', officeOrOwner, async (req, res) => {
  res.json({ staff: await staff.list(tenantOf(req.user!)) })
})

// Creates the account and emails the one-time sign-in link. `emailSent` is false when the
// account was saved but the email failed.
staffRoutes.post('/staff', officeOrOwner, async (req, res) => {
  const input = StaffInput.parse(req.body)
  res.status(201).json(await staff.invite(req.user!, input))
})

staffRoutes.patch('/staff/:staffId', officeOrOwner, async (req, res) => {
  const { staffId } = StaffParams.parse(req.params)
  const input = StaffInput.parse(req.body)
  res.json({ person: await staff.update(req.user!, staffId, input) })
})

staffRoutes.post('/staff/:staffId/deactivate', officeOrOwner, async (req, res) => {
  const { staffId } = StaffParams.parse(req.params)
  res.json({ person: await staff.deactivate(req.user!, staffId) })
})

staffRoutes.post('/staff/:staffId/reactivate', officeOrOwner, async (req, res) => {
  const { staffId } = StaffParams.parse(req.params)
  res.json({ person: await staff.reactivate(req.user!, staffId) })
})

staffRoutes.post('/staff/:staffId/link', officeOrOwner, async (req, res) => {
  const { staffId } = StaffParams.parse(req.params)
  res.json({ person: await staff.sendLink(req.user!, staffId) })
})
