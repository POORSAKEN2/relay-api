import { Router } from 'express'
import { sendPhoto } from '../../lib/send-photo.ts'
import { requireRole } from '../../middleware/auth.ts'
import { JobParams, JobPhotoParams } from '../dispatch/dispatch.schemas.ts'
import * as technicianJobs from './technician-jobs.service.ts'

// The technician's side of jobs. Who they are comes from the session, never the request.
export const technicianJobsRoutes = Router()

const technician = requireRole('technician')

technicianJobsRoutes.get('/my-jobs', technician, async (req, res) => {
  res.json(await technicianJobs.listMyJobs(req.user!))
})

technicianJobsRoutes.get('/my-jobs/:jobId', technician, async (req, res) => {
  const { jobId } = JobParams.parse(req.params)
  res.json(await technicianJobs.getMyJob(req.user!, jobId))
})

technicianJobsRoutes.get('/my-jobs/:jobId/photos/:photoId', technician, async (req, res) => {
  const { jobId, photoId } = JobPhotoParams.parse(req.params)
  sendPhoto(res, await technicianJobs.getMyJobPhoto(req.user!, jobId, photoId))
})
