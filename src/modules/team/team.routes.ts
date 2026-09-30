import express, { Router } from 'express'
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

// The photo is the request body itself, not JSON. Anything that isn't a small JPEG, PNG or
// WebP is refused by the service, whatever the upload says it is.
const photoBody = express.raw({ type: () => true, limit: '2mb' })

teamRoutes.put('/technicians/:technicianId/photo', staff, photoBody, async (req, res) => {
  const { technicianId } = TechnicianParams.parse(req.params)
  res.json({ technician: await team.setPhoto(req.user!, technicianId, req.body) })
})

// Staff only, like the list. `nosniff` keeps browsers to the type we checked on upload.
teamRoutes.get('/technicians/:technicianId/photo', staff, async (req, res) => {
  const { technicianId } = TechnicianParams.parse(req.params)
  const photo = await team.getPhoto(tenantOf(req.user!), technicianId)
  res
    .set({
      'Content-Type': photo.contentType,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=31536000, immutable',
    })
    .send(photo.data)
})

teamRoutes.delete('/technicians/:technicianId/photo', staff, async (req, res) => {
  const { technicianId } = TechnicianParams.parse(req.params)
  res.json({ technician: await team.removePhoto(req.user!, technicianId) })
})

teamRoutes.post('/technicians/:technicianId/deactivate', staff, async (req, res) => {
  const { technicianId } = TechnicianParams.parse(req.params)
  res.json(await team.deactivate(req.user!, technicianId))
})

teamRoutes.post('/technicians/:technicianId/reactivate', staff, async (req, res) => {
  const { technicianId } = TechnicianParams.parse(req.params)
  res.json({ technician: await team.reactivate(req.user!, technicianId) })
})
