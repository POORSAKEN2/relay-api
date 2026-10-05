import type { Tx } from '../../db/client.ts'
import { tenantUrl } from '../../lib/tenant-url.ts'
import { sendText } from '../messaging/sms.ts'
import * as queries from './office-alerts.queries.ts'
import { officeAlertText } from './wording.ts'

// Texts the contractor's owner and office staff about a new booking, in the booking's
// transaction. A priority job sends one priority_alert (any hour) instead of the
// new_booking_alert (held for quiet hours: see rules.ts). The person who booked it is
// skipped: they know already.
export async function sendOfficeAlert(tenantId: string, jobId: string, tx: Tx) {
  const job = await queries.findAlertJob(tenantId, jobId, tx)
  const recipients = await queries.listAlertRecipients(tenantId, job.createdBy, tx)
  if (recipients.length === 0) return
  const link = tenantUrl(job.tenant, `/dashboard?date=${job.date}&job=${jobId}`)
  const body = officeAlertText(job, link)
  const kind = job.priority ? 'priority_alert' : 'new_booking_alert'
  for (const person of recipients) {
    await sendText(tenantId, { contact: person.phone, kind, body, toUserId: person.id, jobId }, tx)
  }
}
