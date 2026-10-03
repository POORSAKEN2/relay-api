import { Router } from 'express'
import { jwtVerify } from 'jose'
import { env } from '../../config/env.ts'
import { HttpError } from '../../lib/http-error.ts'
import { HttpSmsEvent, handleHttpSmsEvent } from './webhooks.service.ts'

export const webhooksRoutes = Router()

// httpSMS calls this for every text sent, delivered, failed or received, and every missed call.
// It answers 200 for anything it handled or chose to ignore; httpSMS retries anything else.
webhooksRoutes.post('/webhooks/httpsms', async (req, res) => {
  await checkSignature(req.headers.authorization)
  await handleHttpSmsEvent(HttpSmsEvent.parse(req.body))
  res.sendStatus(200)
})

// httpSMS signs a JWT (HS256) with the key typed when the webhook was created. The token
// doesn't cover the body: it proves the caller knows the key, nothing more.
async function checkSignature(authorization: string | undefined) {
  const token = authorization?.replace(/^Bearer /, '')
  const key = env.HTTPSMS_WEBHOOK_SIGNING_KEY
  try {
    if (!token || !key) throw new Error('missing')
    await jwtVerify(token, new TextEncoder().encode(key), { algorithms: ['HS256'] })
  } catch {
    throw new HttpError(401, 'unauthorized', 'Invalid webhook signature')
  }
}
