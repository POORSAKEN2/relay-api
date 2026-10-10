import { Router } from 'express'
import { requireRole } from '../../middleware/auth.ts'
import { tenantOf } from '../booking/booking.service.ts'
import { ScheduleInput } from './schedule.schemas.ts'
import * as service from './schedule.service.ts'

export const scheduleRoutes = Router()

const staff = requireRole('owner', 'office')

scheduleRoutes.get('/schedule', staff, async (req, res) => {
  res.json(await service.getSchedule(tenantOf(req.user!)))
})

// Saves nothing: how many upcoming jobs the change would touch.
scheduleRoutes.post('/schedule/check', staff, async (req, res) => {
  const schedule = ScheduleInput.parse(req.body)
  res.json(await service.checkSchedule(tenantOf(req.user!), schedule))
})

scheduleRoutes.put('/schedule', staff, async (req, res) => {
  const schedule = ScheduleInput.parse(req.body)
  res.json(await service.saveSchedule(req.user!, schedule))
})
