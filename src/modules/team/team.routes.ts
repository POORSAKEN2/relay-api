import { Router } from 'express'
import { requireRole } from '../../middleware/auth.ts'
import { tenantOf } from '../booking/booking.service.ts'
import { TechnicianInput, TechnicianParams } from './team.schemas.ts'
import * as team from './team.service.ts'

export const teamRoutes = Router()

const staff = requireRole('owner', 'office')

teamRoutes.get('/technicians', staff, async (req, res) => {
  res.json({ technicians: await team.list(tenantOf(req.user!)) })
})

teamRoutes.post('/technicians', staff, async (req, res) => {
  const input = TechnicianInput.parse(req.body)
  res.status(201).json({ technician: await team.add(req.user!, input) })
})

teamRoutes.patch('/technicians/:technicianId', staff, async (req, res) => {
  const { technicianId } = TechnicianParams.parse(req.params)
  const input = TechnicianInput.parse(req.body)
  res.json({ technician: await team.update(req.user!, technicianId, input) })
})

teamRoutes.post('/technicians/:technicianId/deactivate', staff, async (req, res) => {
  const { technicianId } = TechnicianParams.parse(req.params)
  res.json(await team.deactivate(req.user!, technicianId))
})

teamRoutes.post('/technicians/:technicianId/reactivate', staff, async (req, res) => {
  const { technicianId } = TechnicianParams.parse(req.params)
  res.json({ technician: await team.reactivate(req.user!, technicianId) })
})
