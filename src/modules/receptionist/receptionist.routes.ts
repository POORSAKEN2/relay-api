import { type RequestHandler, Router } from 'express'
import { env } from '../../config/env.ts'
import { HttpError } from '../../lib/http-error.ts'
import { requireRole } from '../../middleware/auth.ts'
import { tenantOf } from '../booking/booking.service.ts'
import { CallParams, StartInput, TurnInput } from './receptionist.schemas.ts'
import * as testConsole from './test-console.service.ts'

export const receptionistRoutes = Router()

const staff = requireRole('owner', 'office')

// A pretend phone call from a browser, to try the receptionist before a phone line exists.
// Off unless RECEPTIONIST_TEST_CONSOLE=true: its bookings are real jobs.
const consoleOn: RequestHandler = (_req, _res, next) => {
  if (!env.RECEPTIONIST_TEST_CONSOLE) throw new HttpError(404, 'not_found', 'Route not found')
  next()
}

// Lets the web app show its "Try the AI receptionist" link only when the console is on.
receptionistRoutes.get('/receptionist/test-console', staff, (_req, res) => {
  res.json({ on: env.RECEPTIONIST_TEST_CONSOLE })
})

receptionistRoutes.post('/receptionist/test-calls', consoleOn, staff, async (req, res) => {
  const { fromPhone } = StartInput.parse(req.body)
  res.status(201).json(await testConsole.startTestCall(tenantOf(req.user!), fromPhone ?? null))
})

receptionistRoutes.post(
  '/receptionist/test-calls/:callId/turns',
  consoleOn,
  staff,
  async (req, res) => {
    const { callId } = CallParams.parse(req.params)
    const { text } = TurnInput.parse(req.body)
    res.json(await testConsole.testTurn(tenantOf(req.user!), callId, text))
  },
)

receptionistRoutes.post(
  '/receptionist/test-calls/:callId/end',
  consoleOn,
  staff,
  async (req, res) => {
    const { callId } = CallParams.parse(req.params)
    await testConsole.endTestCall(tenantOf(req.user!), callId)
    res.sendStatus(204)
  },
)
