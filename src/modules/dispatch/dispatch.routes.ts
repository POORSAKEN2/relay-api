import { Router } from 'express'
import { sendPhoto } from '../../lib/send-photo.ts'
import { requireRole } from '../../middleware/auth.ts'
import { tenantOf } from '../booking/booking.service.ts'
import {
  BoardQuery,
  JobParams,
  JobPhotoParams,
  NoteInput,
  SlotInput,
  StatusInput,
} from './dispatch.schemas.ts'
import * as dispatch from './dispatch.service.ts'

export const dispatchRoutes = Router()

const staff = requireRole('owner', 'office')

dispatchRoutes.get('/dispatch/board', staff, async (req, res) => {
  const { date } = BoardQuery.parse(req.query)
  res.json(await dispatch.getBoard(tenantOf(req.user!), date))
})

dispatchRoutes.get('/jobs/:jobId', staff, async (req, res) => {
  const { jobId } = JobParams.parse(req.params)
  res.json(await dispatch.getJob(tenantOf(req.user!), jobId))
})

dispatchRoutes.get('/jobs/:jobId/photos/:photoId', staff, async (req, res) => {
  const { jobId, photoId } = JobPhotoParams.parse(req.params)
  sendPhoto(res, await dispatch.getJobPhoto(tenantOf(req.user!), jobId, photoId))
})

dispatchRoutes.get('/jobs/:jobId/work-photos/:photoId', staff, async (req, res) => {
  const { jobId, photoId } = JobPhotoParams.parse(req.params)
  sendPhoto(res, await dispatch.getWorkPhoto(tenantOf(req.user!), jobId, photoId))
})

dispatchRoutes.put('/jobs/:jobId/slot', staff, async (req, res) => {
  const { jobId } = JobParams.parse(req.params)
  const input = SlotInput.parse(req.body)
  res.json(await dispatch.moveJob(req.user!, jobId, input))
})

dispatchRoutes.post('/jobs/:jobId/status', staff, async (req, res) => {
  const { jobId } = JobParams.parse(req.params)
  const { status } = StatusInput.parse(req.body)
  res.json(await dispatch.setStatus(req.user!, jobId, status))
})

dispatchRoutes.post('/jobs/:jobId/notes', staff, async (req, res) => {
  const { jobId } = JobParams.parse(req.params)
  const { body } = NoteInput.parse(req.body)
  res.status(201).json({ note: await dispatch.addNote(req.user!, jobId, body) })
})
