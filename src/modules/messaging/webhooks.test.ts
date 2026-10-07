import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { SignJWT } from 'jose'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTenant, resetDb } from '../../../test/helpers.ts'
import { createApp } from '../../app.ts'
import { env } from '../../config/env.ts'
import { db } from '../../db/client.ts'
import { calls, consentEvents, customers, messages, phoneNumbers } from '../../db/schema.ts'
import { emitToTenant } from '../../realtime/index.ts'
import { sendText } from './sms.ts'

vi.mock('../../realtime/index.ts', () => ({ emitToTenant: vi.fn() }))

const app = createApp()
const KEY = 'test-webhook-signing-key'
const OWNER = '+639170000000' // the contractor's httpSMS phone
const HOMEOWNER = '+639171234567'

beforeEach(async () => {
  await resetDb()
  vi.mocked(emitToTenant).mockClear()
  env.HTTPSMS_WEBHOOK_SIGNING_KEY = KEY
})
afterEach(() => {
  env.HTTPSMS_WEBHOOK_SIGNING_KEY = undefined
})

async function token(key = KEY) {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(key))
}

// A signed event from the contractor's phone. httpSMS only needs a 200 back.
async function post(type: string, data: object, id = randomUUID()) {
  await request(app)
    .post('/api/webhooks/httpsms')
    .set('Authorization', `Bearer ${await token()}`)
    .send({ id, type, specversion: '1.0', data: { owner: OWNER, ...data } })
    .expect(200)
}

async function shop() {
  const tenant = await createTenant('desert')
  await db.insert(phoneNumbers).values({ tenantId: tenant.id, number: OWNER })
  return tenant
}

// A text Relay handed to httpSMS, which knows it as 'httpsms-1'.
async function handedOver(tenantId: string) {
  const [text] = await db
    .insert(messages)
    .values({
      tenantId,
      channel: 'sms',
      direction: 'outbound',
      status: 'queued',
      contact: HOMEOWNER,
      kind: 'on_my_way',
      body: 'On my way',
      providerMessageId: 'httpsms-1',
      attempts: 1,
    })
    .returning()
  return text
}

// An outbound text waiting to go: queued with a future sendAfter.
async function waiting(tenantId: string, values: Partial<typeof messages.$inferInsert> = {}) {
  const [text] = await db
    .insert(messages)
    .values({
      tenantId,
      channel: 'sms',
      direction: 'outbound',
      status: 'queued',
      contact: HOMEOWNER,
      kind: 'reminder',
      body: 'x',
      sendAfter: new Date(Date.now() + 60 * 60 * 1000),
      ...values,
    })
    .returning()
  return text
}

async function statusOf(id: string) {
  const [text] = await db.select().from(messages).where(eq(messages.id, id))
  return text
}

describe('POST /api/webhooks/httpsms', () => {
  it('refuses a request without a valid signature', async () => {
    const body = { id: randomUUID(), type: 'message.phone.sent', data: {} }
    await request(app).post('/api/webhooks/httpsms').send(body).expect(401)
    await request(app)
      .post('/api/webhooks/httpsms')
      .set('Authorization', `Bearer ${await token('another-key')}`)
      .send(body)
      .expect(401)
  })

  it('moves a text forward as the phone reports, never back', async () => {
    const tenant = await shop()
    const text = await handedOver(tenant.id)

    await post('message.phone.sent', { request_id: text.id, id: 'httpsms-1' })
    expect((await statusOf(text.id)).status).toBe('sent')
    await post('message.phone.delivered', { id: 'httpsms-1' })
    expect((await statusOf(text.id)).status).toBe('delivered')
    // A late "sent" arrives after "delivered".
    await post('message.phone.sent', { request_id: text.id, id: 'httpsms-1' })
    expect((await statusOf(text.id)).status).toBe('delivered')
  })

  it('fails a text the phone couldn’t send, or gave up on', async () => {
    const tenant = await shop()
    const text = await handedOver(tenant.id)

    await post('message.send.expired', { message_id: 'httpsms-1', is_final: false })
    expect((await statusOf(text.id)).status).toBe('queued')
    await post('message.send.failed', {
      request_id: text.id,
      error_message: 'MOBILE_APP_INACTIVE',
    })
    expect(await statusOf(text.id)).toMatchObject({
      status: 'failed',
      lastError: 'MOBILE_APP_INACTIVE',
    })
  })

  it('ignores an event it has already handled', async () => {
    const tenant = await shop()
    const id = randomUUID()
    await post('message.phone.received', { contact: HOMEOWNER, content: 'Hi' }, id)
    await post('message.phone.received', { contact: HOMEOWNER, content: 'Hi' }, id)
    expect(await db.select().from(messages).where(eq(messages.tenantId, tenant.id))).toHaveLength(1)
    expect(emitToTenant).toHaveBeenCalledTimes(1)
  })

  it('saves a text from a homeowner, matched to their customer record', async () => {
    const tenant = await shop()
    const [customer] = await db
      .insert(customers)
      .values({ tenantId: tenant.id, name: 'Ana Cruz', phone: HOMEOWNER, source: 'office' })
      .returning()

    // The phone may report the number the local way.
    await post('message.phone.received', {
      contact: '09171234567',
      content: 'Is the technician still coming?',
      message_id: 'httpsms-in-1',
    })

    expect(await db.select().from(messages)).toEqual([
      expect.objectContaining({
        tenantId: tenant.id,
        direction: 'inbound',
        status: 'received',
        kind: 'inbound',
        contact: HOMEOWNER,
        body: 'Is the technician still coming?',
        customerId: customer.id,
        providerMessageId: 'httpsms-in-1',
      }),
    ])
    // The office's inbox hears about it once the text is saved.
    expect(emitToTenant).toHaveBeenCalledWith(tenant.id, 'inbox.updated', { contact: HOMEOWNER })
  })

  it.each(['STOP', 'stopall', 'Unsubscribe', 'cancel', 'END', 'quit', 'Stop.', ' stop!! '])(
    'records "%s" as an opt-out',
    async (word) => {
      const tenant = await shop()
      await post('message.phone.received', { contact: HOMEOWNER, content: word })

      const [inbound] = await db.select().from(messages).where(eq(messages.direction, 'inbound'))
      const consent = await db.select().from(consentEvents)
      expect(consent).toEqual([
        expect.objectContaining({
          tenantId: tenant.id,
          contact: HOMEOWNER,
          channel: 'sms',
          source: 'sms_reply',
          granted: false,
          messageId: inbound.id,
        }),
      ])
    },
  )

  it('records UNSTOP as consent to receive texts', async () => {
    const tenant = await shop()
    await post('message.phone.received', { contact: HOMEOWNER, content: 'UNSTOP' })

    const [inbound] = await db.select().from(messages).where(eq(messages.direction, 'inbound'))
    const consent = await db.select().from(consentEvents)
    expect(consent).toEqual([
      expect.objectContaining({
        tenantId: tenant.id,
        contact: HOMEOWNER,
        channel: 'sms',
        source: 'sms_reply',
        granted: true,
        messageId: inbound.id,
      }),
    ])
  })

  it.each(['Please stop texting me', 'STOP?'])(
    'saves "%s" as an inbound text without changing consent',
    async (content) => {
      const tenant = await shop()
      await post('message.phone.received', { contact: HOMEOWNER, content })

      expect(await db.select().from(messages)).toEqual([
        expect.objectContaining({
          tenantId: tenant.id,
          direction: 'inbound',
          body: content,
        }),
      ])
      expect(await db.select().from(consentEvents)).toHaveLength(0)
    },
  )

  it('sends no reply back after a STOP', async () => {
    await shop()
    await post('message.phone.received', { contact: HOMEOWNER, content: 'STOP' })

    const rows = await db.select().from(messages)
    expect(rows).toHaveLength(1)
    expect(rows[0].direction).toBe('inbound')
  })

  it('blocks waiting homeowner texts on STOP, leaving staff texts and texts on the phone', async () => {
    const tenant = await shop()
    const otherTenant = await createTenant('other')

    const heldReminder = await waiting(tenant.id, { kind: 'reminder' })
    const retrying = await waiting(tenant.id, { kind: 'on_my_way', attempts: 1 })
    const onPhone = await waiting(tenant.id, { kind: 'on_my_way', providerMessageId: 'httpsms-9' })
    const staffText = await waiting(tenant.id, { kind: 'job_assigned' })
    const otherContractor = await waiting(otherTenant.id, { kind: 'reminder' })

    await post('message.phone.received', { contact: HOMEOWNER, content: 'STOP' })

    expect(await statusOf(heldReminder.id)).toMatchObject({
      status: 'blocked',
      blockedReason: 'opted_out',
    })
    expect(await statusOf(retrying.id)).toMatchObject({
      status: 'blocked',
      blockedReason: 'opted_out',
    })
    expect(await statusOf(onPhone.id)).toMatchObject({ status: 'queued', blockedReason: null })
    expect(await statusOf(staffText.id)).toMatchObject({ status: 'queued', blockedReason: null })
    expect(await statusOf(otherContractor.id)).toMatchObject({
      status: 'queued',
      blockedReason: null,
    })
  })

  it('does not revive blocked texts on START', async () => {
    const tenant = await shop()
    const held = await waiting(tenant.id, { kind: 'reminder' })

    await post('message.phone.received', { contact: HOMEOWNER, content: 'STOP' })
    expect((await statusOf(held.id)).status).toBe('blocked')

    await post('message.phone.received', { contact: HOMEOWNER, content: 'START' })
    expect((await statusOf(held.id)).status).toBe('blocked')
  })

  it('round trip: webhook STOP blocks later texts, START allows them again', async () => {
    const tenant = await shop()

    await post('message.phone.received', { contact: HOMEOWNER, content: 'STOP' })
    await sendText(tenant.id, { contact: HOMEOWNER, kind: 'text_back', body: 'after stop' })
    await post('message.phone.received', { contact: HOMEOWNER, content: 'START' })
    await sendText(tenant.id, { contact: HOMEOWNER, kind: 'text_back', body: 'after start' })

    const [afterStop] = await db.select().from(messages).where(eq(messages.body, 'after stop'))
    const [afterStart] = await db.select().from(messages).where(eq(messages.body, 'after start'))
    expect(afterStop).toMatchObject({ status: 'blocked', blockedReason: 'opted_out' })
    expect(afterStart).toMatchObject({ status: 'queued', blockedReason: null })
  })

  it('records a missed call and texts the caller a booking link', async () => {
    const tenant = await shop()

    await post('message.call.missed', {
      contact: HOMEOWNER,
      message_id: 'call-1',
      timestamp: '2030-01-08T09:15:00+08:00',
    })

    const saved = await db.select().from(calls)
    expect(saved).toEqual([
      expect.objectContaining({
        tenantId: tenant.id,
        providerSid: 'call-1',
        fromPhone: HOMEOWNER,
        toPhone: OWNER,
        answeredBy: null,
        startedAt: new Date('2030-01-08T01:15:00Z'),
      }),
    ])
    expect(await db.select().from(messages)).toEqual([
      expect.objectContaining({
        kind: 'text_back',
        status: 'queued',
        contact: HOMEOWNER,
        callId: saved[0].id,
        body: expect.stringContaining(`?call=${saved[0].id}&phone=`),
      }),
    ])
  })

  it('saves one call and one text when the same missed-call event comes twice', async () => {
    await shop()
    const eventId = randomUUID()
    const data = { contact: HOMEOWNER, message_id: 'call-1' }

    await post('message.call.missed', data, eventId)
    await post('message.call.missed', data, eventId)
    // httpSMS sent it again under a new event id: the call is still known.
    await post('message.call.missed', data)

    expect(await db.select().from(calls)).toHaveLength(1)
    expect(await db.select().from(messages)).toHaveLength(1)
  })

  it('records a missed call from a hidden number without texting', async () => {
    await shop()
    await post('message.call.missed', { message_id: 'call-1' })
    expect(await db.select().from(calls)).toHaveLength(1)
    expect(await db.select().from(messages)).toHaveLength(0)
  })

  it('answers 200 to an event for a number no contractor has, and saves nothing', async () => {
    await createTenant('desert')
    await post('message.phone.received', { contact: HOMEOWNER, content: 'Hi' })
    expect(await db.select().from(messages)).toHaveLength(0)
    expect(emitToTenant).not.toHaveBeenCalled()
  })
})
