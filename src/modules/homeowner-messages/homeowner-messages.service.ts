import { db, type Tx } from '../../db/client.ts'
import type { PaidInvoice } from '../charges/charges.service.ts'
import { queueEmail } from '../messaging/emails.ts'
import type { MessageKind } from '../messaging/rules.ts'
import { sendText } from '../messaging/sms.ts'
import * as queries from './homeowner-messages.queries.ts'
import {
  confirmationMessage,
  type Message,
  receiptMessage,
  reminderMessage,
  reviewRequestMessage,
} from './wording.ts'

// What a homeowner hears about their visit: the booking confirmation, reminders a day and two
// hours before, the receipt and a review request. Each goes as a text when they have a phone
// and as an email when they have an address, saved in the caller's transaction and sent by
// the sender loop. Whether a text may go, and when, is messaging's rule (rules.ts).

type Visit = NonNullable<Awaited<ReturnType<typeof queries.findVisit>>>

// Visits get their reminders this many hours ahead. The 2-hour pass runs first, so a visit
// already inside it (the server was down, say) isn't also sent the day-before one.
const REMINDER_HOURS = [2, 24]

async function sendToHomeowner(
  tenantId: string,
  jobId: string,
  visit: Visit,
  kind: MessageKind,
  message: Message,
  tx: Tx,
) {
  const about = { jobId, customerId: visit.customerId }
  if (visit.phone) {
    await sendText(tenantId, { contact: visit.phone, kind, body: message.text, ...about }, tx)
  }
  if (visit.email) {
    await queueEmail(
      tenantId,
      { contact: visit.email, kind, subject: message.subject, body: message.email, ...about },
      tx,
    )
  }
}

// Every way of booking calls this once the job and the homeowner's consent are saved.
// `manageUrl`: the homeowner's private link to change or cancel, when the booking made one.
export async function sendBookingConfirmation(
  tenantId: string,
  jobId: string,
  tx: Tx,
  options: { manageUrl?: string } = {},
) {
  const visit = await queries.findVisit(tenantId, jobId, tx)
  await sendToHomeowner(
    tenantId,
    jobId,
    visit,
    'booking_confirmation',
    confirmationMessage(visit, options.manageUrl),
    tx,
  )
}

// Run every 5 minutes by the 'visit-reminders' job. Returns how many visits were reminded.
export async function sendVisitReminders() {
  let reminded = 0
  for (const hours of REMINDER_HOURS) {
    const due = await queries.listJobsToRemind(hours)
    for (const { tenantId, jobId } of due) {
      await db.transaction(async (tx) => {
        const visit = await queries.findVisit(tenantId, jobId, tx)
        await sendToHomeowner(tenantId, jobId, visit, 'reminder', reminderMessage(visit), tx)
      })
    }
    reminded += due.length
  }
  return reminded
}

// Once the payment is recorded, in the same transaction.
export async function sendReceipt(tenantId: string, jobId: string, invoice: PaidInvoice, tx: Tx) {
  const visit = await queries.findVisit(tenantId, jobId, tx)
  const receipt = { ...invoice, currency: visit.currency }
  await sendToHomeowner(tenantId, jobId, visit, 'invoice', receiptMessage(visit, receipt), tx)
}

// When the job is done. Only for a contractor who has set where reviews go.
export async function sendReviewRequest(tenantId: string, jobId: string, tx: Tx) {
  const visit = await queries.findVisit(tenantId, jobId, tx)
  if (!visit.reviewUrl) return
  const message = reviewRequestMessage(visit, visit.reviewUrl)
  await sendToHomeowner(tenantId, jobId, visit, 'review_request', message, tx)
}
