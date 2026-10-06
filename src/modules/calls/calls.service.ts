import type { Tx } from '../../db/client.ts'
import { tenantUrl } from '../../lib/tenant-url.ts'
import { sendText } from '../messaging/sms.ts'
import * as queries from './calls.queries.ts'

// At most one text-back per caller in this window, however many times they ring.
const TEXT_BACK_GAP_HOURS = 12

// Texts a caller nobody answered a link to book online. Runs in the transaction that saved
// the call, so the call and its text are saved together. Any provider's webhook (httpSMS
// today, Twilio later) calls this once it has saved a missed call.
export async function textBackMissedCall(tenantId: string, callId: string, tx: Tx) {
  const call = await queries.findMissedCall(tenantId, callId, tx)
  if (!call?.fromPhone) return // answered, or caller ID hidden: nobody to text

  const since = new Date(Date.now() - TEXT_BACK_GAP_HOURS * 3_600_000)
  if (await queries.textedBackSince(tenantId, call.fromPhone, since, tx)) return

  // `call` lets the booking count as recovered; `phone` fills in the contact step.
  const link = tenantUrl(
    call.tenant,
    `/?call=${call.id}&phone=${encodeURIComponent(call.fromPhone)}`,
  )
  await sendText(
    tenantId,
    {
      contact: call.fromPhone,
      kind: 'text_back',
      body: `${call.tenant.name}: sorry we missed your call. Book a visit here: ${link} Reply STOP to opt out.`,
      callId: call.id,
      customerId: call.customerId ?? undefined,
    },
    tx,
  )
}
