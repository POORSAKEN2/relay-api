import type { Tx } from '../../db/client.ts'
import { tenantUrl } from '../../lib/tenant-url.ts'
import { sendText } from '../messaging/sms.ts'
import * as recovery from '../online-booking/recovery.ts'
import { missedCallerReminderText } from '../online-booking/recovery-texts.ts'
import * as queries from './calls.queries.ts'

// At most one text-back per caller in this window, however many times they ring.
const TEXT_BACK_GAP_HOURS = 12

// At most one next-morning reminder per caller in this many days.
const REMINDER_GAP_DAYS = 7

// Texts a caller nobody answered a link to book online. Runs in the transaction that saved
// the call, so the call and its text are saved together. Any provider's webhook (httpSMS
// today, Twilio later) calls this once it has saved a missed call.
export async function textBackMissedCall(tenantId: string, callId: string, tx: Tx) {
  const call = await queries.findMissedCall(tenantId, callId, tx)
  if (!call?.fromPhone) return // answered, or caller ID hidden: nobody to text

  const since = new Date(Date.now() - TEXT_BACK_GAP_HOURS * 3_600_000)
  if (await queries.textedBackSince(tenantId, call.fromPhone, since, tx)) return

  await sendText(
    tenantId,
    {
      contact: call.fromPhone,
      kind: 'text_back',
      body: `${call.tenant.name}: sorry we missed your call. Book a visit here: ${callLink(call.tenant, call.id, call.fromPhone)} Reply STOP to opt out.`,
      callId: call.id,
      customerId: call.customerId ?? undefined,
    },
    tx,
  )
}

// Run every 5 minutes by the 'booking-recovery' job: a missed caller who agreed to texts and
// hasn't booked gets one text the next morning, with the open times. Returns how many.
export async function sendMissedCallerReminders(now = new Date()) {
  const remindedSince = new Date(now.getTime() - REMINDER_GAP_DAYS * 24 * 3_600_000)
  let reminded = 0
  for (const tenant of await recovery.listDueTenants(now)) {
    const callers = await queries.listCallersToRemind(tenant.id, { ...tenant, remindedSince })
    if (callers.length === 0) continue
    const windows = await recovery.nextOpenWindows(tenant.id)
    for (const caller of callers) {
      // The saved text, with its call, is the record that this caller was reminded.
      await sendText(tenant.id, {
        contact: caller.phone,
        kind: 'missed_caller_reminder',
        body: missedCallerReminderText({
          tenantName: tenant.name,
          windows,
          link: callLink(tenant, caller.id, caller.phone),
        }),
        callId: caller.id,
        customerId: caller.customerId ?? undefined,
      })
    }
    reminded += callers.length
  }
  return reminded
}

// The booking page for a missed caller: `call` lets the booking count as recovered; `phone`
// fills in the contact step.
function callLink(
  tenant: { slug: string; customDomain: string | null; customDomainVerifiedAt: Date | null },
  callId: string,
  phone: string,
) {
  return tenantUrl(tenant, `/?call=${callId}&phone=${encodeURIComponent(phone)}`)
}
