import { Router } from 'express'
import { requireRole } from '../../middleware/auth.ts'
import * as technicianJobs from './technician-jobs.service.ts'

// The technician's side of jobs. Who they are comes from the session, never the request.
export const technicianJobsRoutes = Router()

const technician = requireRole('technician')

technicianJobsRoutes.get('/my-jobs', technician, async (req, res) => {
  res.json(await technicianJobs.listMyJobs(req.user!))
})
