import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { SignJWT } from 'jose'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTenant, resetDb } from '../../../test/helpers.ts'
import { createApp } from '../../app.ts'
import { env } from '../../config/env.ts'
import { db } from '../../db/client.ts'
import { calls, consentEvents, customers, messages, phoneNumbers } from '../../db/schema.ts'

const app = createApp()
const KEY = 'test-webhook-signing-key'
const OWNER = '+639170000000' // the contractor's httpSMS phone
const HOMEOWNER = '+639171234567'

beforeEach(async () => {
  await resetDb()
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
  })

  it('records STOP and START replies as consent', async () => {
    const tenant = await shop()

    await post('message.phone.received', { contact: HOMEOWNER, content: ' stop ' })
    await post('message.phone.received', { contact: HOMEOWNER, content: 'START' })

    const consent = await db.select().from(consentEvents).orderBy(consentEvents.createdAt)
    expect(consent).toEqual([
      expect.objectContaining({ tenantId: tenant.id, contact: HOMEOWNER, granted: false }),
      expect.objectContaining({ tenantId: tenant.id, contact: HOMEOWNER, granted: true }),
    ])
    expect(consent[0]).toMatchObject({ channel: 'sms', source: 'sms_reply' })
  })

  it('records a missed call', async () => {
    const tenant = await shop()

    await post('message.call.missed', {
      contact: HOMEOWNER,
      message_id: 'call-1',
      timestamp: '2030-01-08T09:15:00+08:00',
    })

    expect(await db.select().from(calls)).toEqual([
      expect.objectContaining({
        tenantId: tenant.id,
        providerSid: 'call-1',
        fromPhone: HOMEOWNER,
        toPhone: OWNER,
        answeredBy: null,
        startedAt: new Date('2030-01-08T01:15:00Z'),
      }),
    ])
  })

  it('answers 200 to an event for a number no contractor has, and saves nothing', async () => {
    await createTenant('desert')
    await post('message.phone.received', { contact: HOMEOWNER, content: 'Hi' })
    expect(await db.select().from(messages)).toHaveLength(0)
  })
})
