import { Router } from 'express'
import { requireRole } from '../../middleware/auth.ts'
import { RecoveryQuery, WeeklyQuery } from './analytics.schemas.ts'
import * as analytics from './analytics.service.ts'

export const analyticsRoutes = Router()

// Owner only, like billing: the MVP's recovered-revenue dashboard is the owner's, and it
// shows revenue.
analyticsRoutes.get('/analytics/recovery', requireRole('owner'), async (req, res) => {
  res.json(await analytics.getRecovery(req.user!, RecoveryQuery.parse(req.query)))
})

analyticsRoutes.get('/analytics/recovery/weekly', requireRole('owner'), async (req, res) => {
  res.json(await analytics.getWeekly(req.user!, WeeklyQuery.parse(req.query)))
})
