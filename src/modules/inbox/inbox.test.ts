import { eq } from 'drizzle-orm'
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  createShop,
  createTechnician,
  createUser,
  resetDb,
  type Shop,
  signIn,
  signInTechnician,
} from '../../../test/helpers.ts'
import { createApp } from '../../app.ts'
import { db } from '../../db/client.ts'
import { auditEvents, consentEvents, customers, messages } from '../../db/schema.ts'

const app = createApp()
const MARIA = '+16025550111' // the shop's customer
const STRANGER = '+16025550199' // texted in, no customer

beforeEach(resetDb)

// A text in the database, `minutesAgo` old so the order is certain.
async function text(
  shop: Shop,
  values: Partial<typeof messages.$inferInsert> & { minutesAgo: number },
) {
  const { minutesAgo, ...rest } = values
  const inbound = rest.direction === 'inbound'
  const [row] = await db
    .insert(messages)
    .values({
      tenantId: shop.tenant.id,
      channel: 'sms',
      direction: 'outbound',
      status: inbound ? 'received' : 'sent',
      kind: inbound ? 'inbound' : 'booking_confirmation',
      contact: MARIA,
      body: 'x',
      createdAt: new Date(Date.now() - minutesAgo * 60_000),
      ...rest,
    })
    .returning()
  return row
}

const fromHomeowner = { direction: 'inbound' as const, status: 'received' as const }

describe('GET /api/inbox/threads', () => {
  it('lists threads newest first, with the customer, the last text and unread counts', async () => {
    const shop = await createShop('desert')
    await text(shop, { body: 'Your visit is booked', minutesAgo: 30 })
    await text(shop, { ...fromHomeowner, body: 'Can you come earlier?', minutesAgo: 20 })
    await text(shop, { ...fromHomeowner, contact: STRANGER, body: 'Hello?', minutesAgo: 10 })
    await text(shop, { ...fromHomeowner, contact: STRANGER, body: 'Anyone?', minutesAgo: 5 })
    // Staff texts and emails are not homeowner threads.
    await text(shop, {
      contact: '+14805550123',
      kind: 'job_assigned',
      toUserId: shop.mike.id,
      minutesAgo: 1,
    })
    await text(shop, { channel: 'email', contact: 'maria@example.com', minutesAgo: 1 })

    const res = await request(app).get('/api/inbox/threads').set('Cookie', shop.cookie).expect(200)

    expect(res.body).toEqual({
      threads: [
        {
          contact: STRANGER,
          customer: null,
          lastMessage: { body: 'Anyone?', direction: 'inbound', createdAt: expect.any(String) },
          unread: 2,
        },
        {
          contact: MARIA,
          customer: { id: shop.customer.id, name: 'Maria Lopez' },
          lastMessage: {
            body: 'Can you come earlier?',
            direction: 'inbound',
            createdAt: expect.any(String),
          },
          unread: 1,
        },
      ],
      unreadTotal: 3,
    })
  })

  it('names a shared phone after its oldest customer', async () => {
    const shop = await createShop('desert')
    await db
      .insert(customers)
      .values({ tenantId: shop.tenant.id, name: 'Luis Lopez', phone: MARIA, source: 'office' })
    await text(shop, { ...fromHomeowner, minutesAgo: 1 })

    const res = await request(app).get('/api/inbox/threads').set('Cookie', shop.cookie).expect(200)

    expect(res.body.threads[0].customer.name).toBe('Maria Lopez')
  })

  it('shows another contractor nothing', async () => {
    const shop = await createShop('desert')
    const other = await createShop('other')
    await text(shop, { ...fromHomeowner, minutesAgo: 1 })

    const res = await request(app).get('/api/inbox/threads').set('Cookie', other.cookie).expect(200)

    expect(res.body).toEqual({ threads: [], unreadTotal: 0 })
  })

  it('is for the owner and office only', async () => {
    const shop = await createShop('desert')
    const owner = await createUser('owner', shop.tenant.id)
    await request(app).get('/api/inbox/threads').expect(401)
    await request(app)
      .get('/api/inbox/threads')
      .set('Cookie', await signInTechnician(shop.mike))
      .expect(403)
    await request(app)
      .get('/api/inbox/threads')
      .set('Cookie', await signIn(owner.email))
      .expect(200)
  })
})

describe('GET /api/inbox/messages', () => {
  it('gives the thread oldest first, with who typed each reply', async () => {
    const shop = await createShop('desert')
    await text(shop, { body: 'Your visit is booked', minutesAgo: 30 })
    await text(shop, { ...fromHomeowner, body: 'Can you come earlier?', minutesAgo: 20 })
    await text(shop, {
      kind: 'manual',
      body: 'Yes, 8 AM works',
      sentByUserId: shop.office.id,
      minutesAgo: 10,
    })

    const res = await request(app)
      .get('/api/inbox/messages')
      .query({ contact: MARIA })
      .set('Cookie', shop.cookie)
      .expect(200)

    expect(res.body.messages.map((m: { body: string }) => m.body)).toEqual([
      'Your visit is booked',
      'Can you come earlier?',
      'Yes, 8 AM works',
    ])
    expect(res.body.messages[0]).toMatchObject({ kind: 'booking_confirmation', sentBy: null })
    expect(res.body.messages[2]).toMatchObject({
      direction: 'outbound',
      kind: 'manual',
      status: 'sent',
      blockedReason: null,
      sentBy: { name: 'Test office' },
    })
  })

  it('answers 404 for a number with no texts, and 400 for something not a phone', async () => {
    const shop = await createShop('desert')
    const other = await createShop('other')
    await text(other, { ...fromHomeowner, minutesAgo: 1 })

    await request(app)
      .get('/api/inbox/messages')
      .query({ contact: MARIA })
      .set('Cookie', shop.cookie)
      .expect(404)
    await request(app)
      .get('/api/inbox/messages')
      .query({ contact: 'nope' })
      .set('Cookie', shop.cookie)
      .expect(400)
  })
})

describe('POST /api/inbox/messages', () => {
  it('queues the reply as a manual text from the signed-in user, and audits it', async () => {
    const shop = await createShop('desert')
    await text(shop, { ...fromHomeowner, body: 'Can you come earlier?', minutesAgo: 1 })

    const res = await request(app)
      .post('/api/inbox/messages')
      .set('Cookie', shop.cookie)
      .send({ contact: '(602) 555-0111', body: '  Yes, 8 AM works  ' })
      .expect(201)

    expect(res.body.message).toMatchObject({
      direction: 'outbound',
      kind: 'manual',
      body: 'Yes, 8 AM works',
      status: 'queued',
      sentBy: { name: 'Test office' },
    })
    const [saved] = await db.select().from(messages).where(eq(messages.id, res.body.message.id))
    expect(saved).toMatchObject({
      contact: MARIA,
      sentByUserId: shop.office.id,
      customerId: shop.customer.id,
    })
    const [audit] = await db.select().from(auditEvents)
    expect(audit).toMatchObject({
      actorType: 'user',
      actorUserId: shop.office.id,
      action: 'message.sent',
      entityId: saved.id,
      data: { kind: 'manual' },
    })
  })

  it('saves a reply to someone who texted STOP as blocked', async () => {
    const shop = await createShop('desert')
    const stop = await text(shop, { ...fromHomeowner, body: 'STOP', minutesAgo: 1 })
    await db.insert(consentEvents).values({
      tenantId: shop.tenant.id,
      contact: MARIA,
      channel: 'sms',
      granted: false,
      source: 'sms_reply',
      messageId: stop.id,
    })

    const res = await request(app)
      .post('/api/inbox/messages')
      .set('Cookie', shop.cookie)
      .send({ contact: MARIA, body: 'Sorry to see you go' })
      .expect(201)

    expect(res.body.message).toMatchObject({ status: 'blocked', blockedReason: 'opted_out' })
  })

  it('never starts a thread, and checks the reply', async () => {
    const shop = await createShop('desert')
    await text(shop, { ...fromHomeowner, minutesAgo: 1 })
    // A technician's number has staff texts only: still no thread.
    const technician = await createTechnician(shop.tenant.id, 'Lee')
    await text(shop, {
      contact: technician.phone!,
      kind: 'job_assigned',
      toUserId: technician.id,
      minutesAgo: 1,
    })

    const reply = (body: object) =>
      request(app).post('/api/inbox/messages').set('Cookie', shop.cookie).send(body)

    await reply({ contact: STRANGER, body: 'Hi' }).expect(404)
    await reply({ contact: technician.phone, body: 'Hi' }).expect(404)
    const empty = await reply({ contact: MARIA, body: '   ' }).expect(400)
    expect(empty.body.error.code).toBe('validation_failed')
    await reply({ contact: MARIA, body: 'x'.repeat(641) }).expect(400)
    await reply({ contact: MARIA, body: 'x'.repeat(640) }).expect(201)
  })
})

describe('POST /api/inbox/read', () => {
  it('marks only that thread’s texts read', async () => {
    const shop = await createShop('desert')
    const maria = await text(shop, { ...fromHomeowner, minutesAgo: 2 })
    const stranger = await text(shop, { ...fromHomeowner, contact: STRANGER, minutesAgo: 1 })

    await request(app)
      .post('/api/inbox/read')
      .set('Cookie', shop.cookie)
      .send({ contact: MARIA })
      .expect(204)

    const readAt = async (id: string) =>
      (await db.select().from(messages).where(eq(messages.id, id)))[0].readAt
    expect(await readAt(maria.id)).toBeInstanceOf(Date)
    expect(await readAt(stranger.id)).toBeNull()
  })

  it('leaves another contractor’s texts alone', async () => {
    const shop = await createShop('desert')
    const other = await createShop('other')
    const theirs = await text(other, { ...fromHomeowner, minutesAgo: 1 })

    await request(app)
      .post('/api/inbox/read')
      .set('Cookie', shop.cookie)
      .send({ contact: MARIA })
      .expect(204)

    const [row] = await db.select().from(messages).where(eq(messages.id, theirs.id))
    expect(row.readAt).toBeNull()
  })
})
