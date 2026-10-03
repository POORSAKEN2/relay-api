import express, { Router } from 'express'
import { sendPhoto } from '../../lib/send-photo.ts'
import { requireRole } from '../../middleware/auth.ts'
import { JobParams, JobPhotoParams } from '../dispatch/dispatch.schemas.ts'
import {
  DecisionInput,
  NoAccessInput,
  OnMyWayInput,
  RepairInput,
  RepairParams,
  RunningLateInput,
  WorkPhotoStageParams,
} from './technician-jobs.schemas.ts'
import * as technicianJobs from './technician-jobs.service.ts'

// The technician's side of jobs. Who they are comes from the session, never the request.
export const technicianJobsRoutes = Router()

const technician = requireRole('technician')
// A photo is the request body itself, not JSON. The service refuses anything that isn't a
// small JPEG, PNG or WebP, whatever the upload says it is.
const photoBody = express.raw({ type: () => true, limit: '2mb' })

technicianJobsRoutes.get('/my-jobs', technician, async (req, res) => {
  res.json(await technicianJobs.listMyJobs(req.user!))
})

technicianJobsRoutes.get('/my-jobs/price-items', technician, async (req, res) => {
  res.json({ priceItems: await technicianJobs.listPriceList(req.user!) })
})

technicianJobsRoutes.get('/my-jobs/:jobId', technician, async (req, res) => {
  const { jobId } = JobParams.parse(req.params)
  res.json(await technicianJobs.getMyJob(req.user!, jobId))
})

technicianJobsRoutes.get('/my-jobs/:jobId/photos/:photoId', technician, async (req, res) => {
  const { jobId, photoId } = JobPhotoParams.parse(req.params)
  sendPhoto(res, await technicianJobs.getMyJobPhoto(req.user!, jobId, photoId))
})

technicianJobsRoutes.post(
  '/my-jobs/:jobId/work-photos/:stage',
  technician,
  photoBody,
  async (req, res) => {
    const { jobId, stage } = WorkPhotoStageParams.parse(req.params)
    res.status(201).json(await technicianJobs.addWorkPhoto(req.user!, jobId, stage, req.body))
  },
)

technicianJobsRoutes.get('/my-jobs/:jobId/work-photos/:photoId', technician, async (req, res) => {
  const { jobId, photoId } = JobPhotoParams.parse(req.params)
  sendPhoto(res, await technicianJobs.getWorkPhoto(req.user!, jobId, photoId))
})

technicianJobsRoutes.delete(
  '/my-jobs/:jobId/work-photos/:photoId',
  technician,
  async (req, res) => {
    const { jobId, photoId } = JobPhotoParams.parse(req.params)
    res.json(await technicianJobs.removeWorkPhoto(req.user!, jobId, photoId))
  },
)

technicianJobsRoutes.post('/my-jobs/:jobId/on-my-way', technician, async (req, res) => {
  const { jobId } = JobParams.parse(req.params)
  const { minutes } = OnMyWayInput.parse(req.body)
  res.json(await technicianJobs.onMyWay(req.user!, jobId, minutes))
})

technicianJobsRoutes.post('/my-jobs/:jobId/running-late', technician, async (req, res) => {
  const { jobId } = JobParams.parse(req.params)
  const { minutes } = RunningLateInput.parse(req.body)
  res.json(await technicianJobs.runningLate(req.user!, jobId, minutes))
})

technicianJobsRoutes.post('/my-jobs/:jobId/start', technician, async (req, res) => {
  const { jobId } = JobParams.parse(req.params)
  res.json(await technicianJobs.startJob(req.user!, jobId))
})

technicianJobsRoutes.post('/my-jobs/:jobId/no-access', technician, async (req, res) => {
  const { jobId } = JobParams.parse(req.params)
  const { note } = NoAccessInput.parse(req.body)
  res.json(await technicianJobs.noAccess(req.user!, jobId, note))
})

technicianJobsRoutes.post('/my-jobs/:jobId/complete', technician, async (req, res) => {
  const { jobId } = JobParams.parse(req.params)
  res.json(await technicianJobs.completeJob(req.user!, jobId))
})

technicianJobsRoutes.post('/my-jobs/:jobId/repairs', technician, async (req, res) => {
  const { jobId } = JobParams.parse(req.params)
  const input = RepairInput.parse(req.body)
  res.json(await technicianJobs.addRepair(req.user!, jobId, input))
})

technicianJobsRoutes.delete('/my-jobs/:jobId/repairs/:itemId', technician, async (req, res) => {
  const { jobId, itemId } = RepairParams.parse(req.params)
  res.json(await technicianJobs.removeRepair(req.user!, jobId, itemId))
})

technicianJobsRoutes.post('/my-jobs/:jobId/repairs/decision', technician, async (req, res) => {
  const { jobId } = JobParams.parse(req.params)
  const { decision } = DecisionInput.parse(req.body)
  res.json(await technicianJobs.decideRepairs(req.user!, jobId, decision))
})
