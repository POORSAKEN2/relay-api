import { eq } from 'drizzle-orm'
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'
import { createTechnician, createTenant, createUser, resetDb } from '../../../test/helpers.ts'
import { createApp } from '../../app.ts'
import { db } from '../../db/client.ts'
import { messages, signInCodes, users } from '../../db/schema.ts'
import { hashCode, requestSignInCode } from './accounts.service.ts'

// Own file: the sign-in limiter allows 10 requests per 15 minutes and counts every request
// this file makes to /api/auth/phone/*, so most cases call the service directly.
const app = createApp()
const MINUTE_MS = 60 * 1000

beforeEach(resetDb)

// A code saved straight in the database, so the test knows what it is.
async function giveCode(
  userId: string,
  code: string,
  values: Partial<typeof signInCodes.$inferInsert> = {},
) {
  await db.insert(signInCodes).values({
    userId,
    codeHash: hashCode(code),
    expiresAt: new Date(Date.now() + 10 * MINUTE_MS),
    ...values,
  })
}

// '+14805550123' → '(480) 555-0123', the way a technician would type it.
function typed(phone: string) {
  return `(${phone.slice(2, 5)}) ${phone.slice(5, 8)}-${phone.slice(8)}`
}

describe('POST /api/auth/phone/code', () => {
  it('saves a code and a text for the technician, without the code in the text', async () => {
    const tenant = await createTenant('desert')
    const tech = await createTechnician(tenant.id, 'Sam')

    await request(app)
      .post('/api/auth/phone/code')
      .send({ phone: typed(tech.phone!) })
      .expect(204)

    const codes = await db.select().from(signInCodes)
    expect(codes).toHaveLength(1)
    expect(codes[0]).toMatchObject({ userId: tech.id, attempts: 0, usedAt: null })
    expect(codes[0].codeHash).toMatch(/^[0-9a-f]{64}$/)
    const texts = await db.select().from(messages)
    expect(texts).toHaveLength(1)
    expect(texts[0]).toMatchObject({
      tenantId: tenant.id,
      channel: 'sms',
      direction: 'outbound',
      status: 'queued',
      kind: 'sign_in_code',
      contact: tech.phone,
      toUserId: tech.id,
      body: 'Sign-in code (not stored)',
    })
  })

  it('answers the same for a number nobody uses, and sends nothing', async () => {
    await request(app).post('/api/auth/phone/code').send({ phone: '(480) 555-0000' }).expect(204)

    expect(await db.select().from(signInCodes)).toHaveLength(0)
    expect(await db.select().from(messages)).toHaveLength(0)
  })

  it('rejects a number that is not 10 digits', async () => {
    const res = await request(app)
      .post('/api/auth/phone/code')
      .send({ phone: '555-01' })
      .expect(400)
    expect(res.body.error.details).toEqual({ phone: ['Enter a 10-digit phone number'] })
  })
})

describe('requestSignInCode', () => {
  it('only texts active technicians', async () => {
    const tenant = await createTenant('desert')
    const gone = await createTechnician(tenant.id, 'Gone')
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, gone.id))
    const office = await createUser('office', tenant.id)
    await db.update(users).set({ phone: '+14805550199' }).where(eq(users.id, office.id))

    await requestSignInCode(gone.phone!)
    await requestSignInCode('+14805550199')

    expect(await db.select().from(signInCodes)).toHaveLength(0)
    expect(await db.select().from(messages)).toHaveLength(0)
  })

  it('texts at most 5 codes an hour to one phone', async () => {
    const tenant = await createTenant('desert')
    const tech = await createTechnician(tenant.id, 'Sam')
    // Over an hour old: deleted, and not counted.
    await giveCode(tech.id, '000000', { createdAt: new Date(Date.now() - 61 * MINUTE_MS) })

    for (let i = 0; i < 6; i++) await requestSignInCode(tech.phone!)

    expect(await db.select().from(signInCodes)).toHaveLength(5)
    expect(await db.select().from(messages)).toHaveLength(5)
  })
})
