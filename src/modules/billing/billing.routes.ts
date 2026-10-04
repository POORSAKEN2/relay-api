import { createHash, timingSafeEqual } from 'node:crypto'
import { Router } from 'express'
import { env } from '../../config/env.ts'
import { HttpError } from '../../lib/http-error.ts'
import { requireRole } from '../../middleware/auth.ts'
import { RevenueCatWebhook } from './billing.schemas.ts'
import * as billing from './billing.service.ts'

export const billingRoutes = Router()

billingRoutes.get('/billing', requireRole('owner'), async (req, res) => {
  res.json(await billing.getSubscription(req.user!))
})

// RevenueCat calls this for every purchase, renewal, billing problem and expiry. It answers 200
// for anything handled or ignored; RevenueCat retries anything else.
billingRoutes.post('/webhooks/revenuecat', async (req, res) => {
  checkAuthorization(req.headers.authorization)
  await billing.handleRevenueCatEvent(RevenueCatWebhook.parse(req.body).event)
  res.sendStatus(200)
})

// RevenueCat sends, as the Authorization header, the value typed when the webhook was created.
function checkAuthorization(authorization: string | undefined) {
  const expected = env.REVENUECAT_WEBHOOK_AUTH
  // Hashing first gives both sides the same length, which timingSafeEqual needs.
  const hash = (value: string) => createHash('sha256').update(value).digest()
  if (!expected || !authorization || !timingSafeEqual(hash(authorization), hash(expected))) {
    throw new HttpError(401, 'unauthorized', 'Invalid webhook authorization')
  }
}
