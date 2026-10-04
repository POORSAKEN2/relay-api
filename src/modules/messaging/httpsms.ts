import { z } from 'zod'
import { env } from '../../config/env.ts'

// httpSMS (https://httpsms.com): an Android phone with a SIM runs the httpSMS app, and this API
// pushes each text to it. The only file that talks to httpSMS; replace it to change provider.

const SEND_URL = 'https://api.httpsms.com/v1/messages/send'

const SendResponse = z.object({ data: z.object({ id: z.string() }) })

// Hands one text to httpSMS and returns its message id. Throws if httpSMS doesn't take it.
// `requestId` is our messages.id: httpSMS sends it back in every webhook about this text.
export async function sendSms(text: {
  from: string
  to: string
  content: string
  requestId: string
}) {
  const res = await fetch(SEND_URL, {
    method: 'POST',
    headers: { 'x-api-key': env.HTTPSMS_API_KEY ?? '', 'content-type': 'application/json' },
    body: JSON.stringify({
      from: text.from,
      to: text.to,
      content: text.content,
      request_id: text.requestId,
    }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) {
    throw new Error(`httpSMS answered ${res.status}: ${(await res.text()).slice(0, 300)}`)
  }
  return SendResponse.parse(await res.json()).data.id
}
