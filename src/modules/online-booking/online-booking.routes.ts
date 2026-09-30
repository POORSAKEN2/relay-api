import { Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import { HttpError } from '../../lib/http-error.ts'
import { tenantFromHost } from '../../middleware/tenant.ts'
import {
  BookingInput,
  CallbackInput,
  DraftAnswersInput,
  DraftInput,
  WaitlistInput,
  ZipParams,
} from './online-booking.schemas.ts'
import * as onlineBooking from './online-booking.service.ts'

// The public booking page. No sign-in: the contractor comes from the web address.
export const onlineBookingRoutes = Router()

// Anyone can post these forms, so one address gets a limited number of tries.
function limitTries(limit: number) {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, _res, next) =>
      next(new HttpError(429, 'rate_limited', 'Too many tries. Wait 15 minutes and try again.')),
  })
}
const formLimit = limitTries(60)
// The wizard saves its draft in the background on every step, so drafts get their own, larger
// count. They never use up the tries of the forms a homeowner sends by hand.
const draftLimit = limitTries(240)

onlineBookingRoutes.get('/online-booking/options', tenantFromHost, async (req, res) => {
  res.json(await onlineBooking.getOptions(req.tenant!))
})

onlineBookingRoutes.get('/online-booking/service-area/:zip', tenantFromHost, async (req, res) => {
  const { zip } = ZipParams.parse(req.params)
  res.json(await onlineBooking.checkZip(req.tenant!.id, zip))
})

onlineBookingRoutes.get('/online-booking/windows', tenantFromHost, async (req, res) => {
  res.json(await onlineBooking.listOpenWindows(req.tenant!.id))
})

onlineBookingRoutes.post(
  '/online-booking/callbacks',
  formLimit,
  tenantFromHost,
  async (req, res) => {
    const input = CallbackInput.parse(req.body)
    await onlineBooking.requestCallback(req.tenant!.id, input)
    res.status(201).json({ ok: true })
  },
)

onlineBookingRoutes.post(
  '/online-booking/waitlist',
  formLimit,
  tenantFromHost,
  async (req, res) => {
    const input = WaitlistInput.parse(req.body)
    await onlineBooking.joinWaitlist(req.tenant!.id, input, req.ip ?? null)
    res.status(201).json({ ok: true })
  },
)

onlineBookingRoutes.post('/online-booking/drafts', draftLimit, tenantFromHost, async (req, res) => {
  const input = DraftInput.parse(req.body)
  res.status(201).json(await onlineBooking.saveDraftContact(req.tenant!, input, req.ip ?? null))
})

onlineBookingRoutes.get(
  '/online-booking/drafts/:token',
  draftLimit,
  tenantFromHost,
  async (req, res) => {
    res.json(await onlineBooking.getDraft(req.tenant!.id, String(req.params.token)))
  },
)

onlineBookingRoutes.patch(
  '/online-booking/drafts/:token',
  draftLimit,
  tenantFromHost,
  async (req, res) => {
    const { answers } = DraftAnswersInput.parse(req.body)
    await onlineBooking.saveDraftAnswers(req.tenant!.id, String(req.params.token), answers)
    res.json({ ok: true })
  },
)

onlineBookingRoutes.post(
  '/online-booking/bookings',
  formLimit,
  tenantFromHost,
  async (req, res) => {
    const input = BookingInput.parse(req.body)
    res.status(201).json(await onlineBooking.bookVisit(req.tenant!, input, req.ip ?? null))
  },
)
