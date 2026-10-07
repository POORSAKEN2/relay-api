import { Router } from 'express'
import { requireRole } from '../../middleware/auth.ts'
import * as exportData from './export.service.ts'

export const exportRoutes = Router()

// Owner only: the export holds every customer's contact details and messages.
exportRoutes.post('/export', requireRole('owner'), async (req, res) => {
  await exportData.streamExport(req.user!, res)
})
