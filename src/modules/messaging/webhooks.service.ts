import { z } from 'zod'
import { db, type Tx } from '../../db/client.ts'
import { Phone } from '../../lib/fields.ts'
import { logger } from '../../lib/logger.ts'
import { textBackMissedCall } from '../calls/calls.service.ts'
import * as queries from './messaging.queries.ts'
import { HOMEOWNER_KINDS } from './rules.ts'

// What httpSMS posts to /api/webhooks/httpsms: a CloudEvent. Field names differ between events
// (a text's id is `id` in some and `message_id` in others), so every data field is optional.
export const HttpSmsEvent = z.object({
  id: z.string().min(1),
  type: z.string(),
  data: z
    .object({
      id: z.string().nullish(),
      message_id: z.string().nullish(),
      request_id: z.string().nullish(), // our messages.id, on texts Relay sent
      owner: z.string().nullish(), // the httpSMS phone's own number
      contact: z.string().nullish(), // the other side
      content: z.string().nullish(),
      error_message: z.string().nullish(),
      is_final: z.boolean().nullish(),
      timestamp: z.string().nullish(),
    })
    .default({}),
})
export type HttpSmsEvent = z.infer<typeof HttpSmsEvent>

// Replies that opt out of texts, or back in. Carriers use the same words. A START from someone
// who never ticked the consent box counts as consent; they asked for texts.
const STOP_WORDS = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']
const START_WORDS = ['START', 'UNSTOP']

// One event, in one transaction with the record that it arrived: if handling fails, httpSMS
// retries and the retry isn't mistaken for a repeat.
export async function handleHttpSmsEvent(event: HttpSmsEvent) {
  await db.transaction(async (tx) => {
    if (!(await queries.recordWebhookEvent(event.id, tx))) return // a repeat
    const { data } = event
    const text = {
      messageId: z.uuid().safeParse(data.request_id).data ?? null,
      providerMessageId: data.id ?? data.message_id ?? null,
    }

    switch (event.type) {
      case 'message.phone.sent':
        await queries.updateTextStatus(text, { status: 'sent' }, ['queued'], tx)
        break
      case 'message.phone.delivered':
        await queries.updateTextStatus(text, { status: 'delivered' }, ['queued', 'sent'], tx)
        break
      case 'message.send.failed':
        await queries.updateTextStatus(
          text,
          { status: 'failed', lastError: data.error_message ?? 'failed on the phone' },
          ['queued', 'sent'],
          tx,
        )
        break
      // The phone was offline too long. Only the last event of a text is final.
      case 'message.send.expired':
        if (data.is_final) {
          await queries.updateTextStatus(
            text,
            { status: 'failed', lastError: 'expired: the phone didn’t send it in time' },
            ['queued', 'sent'],
            tx,
          )
        }
        break
      case 'message.phone.received':
        await receiveText(event, tx)
        break
      case 'message.call.missed':
        await recordMissedCall(event, tx)
        break
      case 'phone.heartbeat.offline':
        logger.warn({ owner: data.owner }, 'httpSMS phone offline: texts wait until it is back')
        break
      case 'phone.heartbeat.online':
        logger.info({ owner: data.owner }, 'httpSMS phone back online')
        break
    }
  })
}

// A text from a homeowner: saved for the inbox, and a STOP or START changes their consent.
async function receiveText(event: HttpSmsEvent, tx: Tx) {
  const found = await findSides(event, tx)
  if (!found?.contact) return
  const { tenantId, contact } = found
  const body = event.data.content ?? ''
  const message = await queries.insertMessage(
    {
      tenantId,
      channel: 'sms',
      direction: 'inbound',
      status: 'received',
      kind: 'inbound',
      contact,
      body,
      providerMessageId: event.data.message_id ?? event.data.id,
      customerId: await queries.findCustomerIdByPhone(tenantId, contact, tx),
    },
    tx,
  )

  // The whole reply is the command. Trailing dots and bangs are dropped ("Stop.") because no
  // carrier catches STOP on an httpSMS phone: Relay is the only thing honoring it.
  const word = body
    .trim()
    .replace(/[.!]+$/, '')
    .toUpperCase()
  if (STOP_WORDS.includes(word) || START_WORDS.includes(word)) {
    const granted = START_WORDS.includes(word)
    await queries.insertReplyConsent(tenantId, { contact, granted, messageId: message.id }, tx)
    if (!granted) await queries.blockWaitingTexts(tenantId, contact, HOMEOWNER_KINDS, tx)
  }
}

// A call nobody answered: saved, and the caller gets a text with a booking link.
async function recordMissedCall(event: HttpSmsEvent, tx: Tx) {
  const found = await findSides(event, tx)
  if (!found) return
  const callId = await queries.insertMissedCall(
    found.tenantId,
    {
      providerSid: event.data.message_id ?? event.id,
      fromPhone: found.contact, // null when the caller hid their number
      toPhone: found.owner,
      customerId: found.contact
        ? await queries.findCustomerIdByPhone(found.tenantId, found.contact, tx)
        : undefined,
      startedAt: event.data.timestamp ? new Date(event.data.timestamp) : undefined,
    },
    tx,
  )
  // No id: the call was already saved by an earlier copy of this event, which texted already.
  if (callId) await textBackMissedCall(found.tenantId, callId, tx)
}

// The contractor (by the phone's own number) and the other side's number as E.164, which is
// how phones are stored everywhere else. undefined when the number isn't a contractor's.
async function findSides(event: HttpSmsEvent, tx: Tx) {
  const owner = event.data.owner ?? ''
  const tenantId = await queries.findTenantIdByNumber(owner, tx)
  if (!tenantId) {
    logger.warn({ owner, eventId: event.id }, 'httpSMS event for a number no contractor has')
    return undefined
  }
  const contact = Phone.safeParse(event.data.contact ?? '').data ?? null
  return { tenantId, owner, contact }
}
