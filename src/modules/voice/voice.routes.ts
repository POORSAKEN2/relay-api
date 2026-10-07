import { createPublicKey, verify } from 'node:crypto'
import { type Request, Router } from 'express'
import { env } from '../../config/env.ts'
import { HttpError } from '../../lib/http-error.ts'
import { handleTelnyxEvent, TelnyxEvent } from './voice.service.ts'

export const voiceRoutes = Router()

// How old a signed webhook may be before it counts as a replay. Telnyx's own SDK uses 5 minutes.
const MAX_AGE_SECONDS = 5 * 60

// Telnyx calls this for every step of a call to our number. The body arrives raw (see app.ts)
// because the signature covers the exact bytes. Anything but a 200 makes Telnyx retry.
voiceRoutes.post('/webhooks/telnyx', async (req, res) => {
  checkSignature(req)
  await handleTelnyxEvent(TelnyxEvent.parse(JSON.parse(req.body.toString('utf8'))))
  res.sendStatus(200)
})

// Telnyx signs "<timestamp>|<raw body>" with Ed25519. The public key from the Telnyx portal
// (TELNYX_PUBLIC_KEY, base64) checks it. The timestamp stops an old request being replayed.
function checkSignature(req: Request) {
  const signature = req.get('telnyx-signature-ed25519')
  const timestamp = req.get('telnyx-timestamp')
  const publicKey = env.TELNYX_PUBLIC_KEY
  const unauthorized = new HttpError(401, 'unauthorized', 'Invalid webhook signature')

  if (!signature || !timestamp || !publicKey || !Buffer.isBuffer(req.body)) throw unauthorized
  const age = Math.abs(Date.now() / 1000 - Number(timestamp))
  if (!/^\d+$/.test(timestamp) || age > MAX_AGE_SECONDS) throw unauthorized

  const signed = Buffer.concat([Buffer.from(`${timestamp}|`), req.body])
  let valid = false
  try {
    // The portal gives the raw 32-byte key in base64; Node reads it as a JWK.
    const key = createPublicKey({
      key: {
        kty: 'OKP',
        crv: 'Ed25519',
        x: Buffer.from(publicKey, 'base64').toString('base64url'),
      },
      format: 'jwk',
    })
    valid = verify(null, signed, key, Buffer.from(signature, 'base64'))
  } catch {
    // A malformed key or signature is just an invalid signature.
  }
  if (!valid) throw unauthorized
}
