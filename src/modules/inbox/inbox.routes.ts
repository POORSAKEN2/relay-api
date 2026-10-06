import { Router } from 'express'
import { requireRole } from '../../middleware/auth.ts'
import { tenantOf } from '../booking/booking.service.ts'
import { ReadInput, ReplyInput, ThreadQuery } from './inbox.schemas.ts'
import * as inbox from './inbox.service.ts'

export const inboxRoutes = Router()

const staff = requireRole('owner', 'office')

inboxRoutes.get('/inbox/threads', staff, async (req, res) => {
  res.json(await inbox.listThreads(tenantOf(req.user!)))
})

inboxRoutes.get('/inbox/messages', staff, async (req, res) => {
  const { contact } = ThreadQuery.parse(req.query)
  res.json(await inbox.getThread(tenantOf(req.user!), contact))
})

inboxRoutes.post('/inbox/messages', staff, async (req, res) => {
  const input = ReplyInput.parse(req.body)
  res.status(201).json(await inbox.reply(tenantOf(req.user!), req.user!, input))
})

inboxRoutes.post('/inbox/read', staff, async (req, res) => {
  const { contact } = ReadInput.parse(req.body)
  await inbox.markRead(tenantOf(req.user!), contact)
  res.sendStatus(204)
})
