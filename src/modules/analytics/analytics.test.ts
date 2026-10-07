import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createJob,
  createShop,
  createUser,
  resetDb,
  type Shop,
  signIn,
} from '../../../test/helpers.ts'
import { createApp } from '../../app.ts'
import { db } from '../../db/client.ts'
import { calls, invoices, messages } from '../../db/schema.ts'

const app = createApp()
let nextInvoiceNumber = 1

beforeEach(async () => {
  await resetDb()
  nextInvoiceNumber = 1
})

function phoenix(local: string) {
  return new Date(`${local}-07:00`)
}

async function owner(shop: Shop) {
  const user = await createUser('owner', shop.tenant.id)
  return signIn(user.email)
}

async function createCall(shop: Shop, values: Partial<typeof calls.$inferInsert> = {}) {
  const [call] = await db
    .insert(calls)
    .values({
      tenantId: shop.tenant.id,
      providerSid: randomUUID(),
      toPhone: '+14805550100',
      fromPhone: '+16025550111',
      ...(values.answeredBy === 'ai' ? { disclosedAt: new Date() } : {}),
      ...values,
    })
    .returning()
  return call
}

async function createTextBack(
  shop: Shop,
  callId: string,
  status: (typeof messages.$inferInsert)['status'],
) {
  const [msg] = await db
    .insert(messages)
    .values({
      tenantId: shop.tenant.id,
      channel: 'sms',
      direction: 'outbound',
      kind: 'text_back',
      contact: '+16025550111',
      body: 'Sorry we missed you',
      callId,
      status,
      ...(status === 'blocked' ? { blockedReason: 'no_consent' } : {}),
    })
    .returning()
  return msg
}

async function createInvoice(
  shop: Shop,
  jobId: string,
  status: (typeof invoices.$inferInsert)['status'],
  totalCents: number,
) {
  const [invoice] = await db
    .insert(invoices)
    .values({
      tenantId: shop.tenant.id,
      jobId,
      number: nextInvoiceNumber++,
      totalCents,
      status,
      paidAt: status === 'paid' ? new Date() : null,
    })
    .returning()
  return invoice
}

function getRecovery(cookie?: string, query: Record<string, string | undefined> = {}) {
  const req = request(app).get('/api/analytics/recovery').query(query)
  return cookie ? req.set('Cookie', cookie) : req
}

describe('GET /api/analytics/recovery', () => {
  it('requires a signed-in owner', async () => {
    await getRecovery(undefined, { from: '2026-10-01', to: '2026-10-31' }).expect(401)

    const shop = await createShop('desert')
    await getRecovery(shop.cookie, { from: '2026-10-01', to: '2026-10-31' }).expect(403)
  })

  it('validates from and to dates', async () => {
    const shop = await createShop('desert')
    const cookie = await owner(shop)

    const resReversed = await getRecovery(cookie, {
      from: '2026-10-31',
      to: '2026-10-01',
    }).expect(400)
    expect(resReversed.body.error.code).toBe('validation_failed')

    const resInvalid = await getRecovery(cookie, {
      from: '2026-02-31',
      to: '2026-10-31',
    }).expect(400)
    expect(resInvalid.body.error.code).toBe('validation_failed')

    const resMissing = await getRecovery(cookie, {
      from: '2026-10-01',
    }).expect(400)
    expect(resMissing.body.error.code).toBe('validation_failed')
  })

  it('counts calls, text-backs, and AI-answered calls accurately', async () => {
    const shop = await createShop('desert')
    const cookie = await owner(shop)

    // In-range missed calls
    const callStart = await createCall(shop, { startedAt: phoenix('2026-10-01T00:00') })
    await createTextBack(shop, callStart.id, 'sent')

    const callEnd = await createCall(shop, { startedAt: phoenix('2026-10-31T23:30') })
    await createTextBack(shop, callEnd.id, 'delivered')

    const callDouble = await createCall(shop, { startedAt: phoenix('2026-10-15T12:00') })
    await createTextBack(shop, callDouble.id, 'sent')
    await createTextBack(shop, callDouble.id, 'sent')

    const callBlocked = await createCall(shop, { startedAt: phoenix('2026-10-16T12:00') })
    await createTextBack(shop, callBlocked.id, 'blocked')

    const callFailed = await createCall(shop, { startedAt: phoenix('2026-10-17T12:00') })
    await createTextBack(shop, callFailed.id, 'failed')

    const callQueued = await createCall(shop, { startedAt: phoenix('2026-10-18T12:00') })
    await createTextBack(shop, callQueued.id, 'queued')

    // Out-of-range missed calls
    const callBefore = await createCall(shop, { startedAt: phoenix('2026-09-30T23:30') })
    await createTextBack(shop, callBefore.id, 'sent')

    await createCall(shop, { startedAt: phoenix('2026-11-01T00:00') })

    // In-range office call
    await createCall(shop, { answeredBy: 'office', startedAt: phoenix('2026-10-10T10:00') })

    // In-range AI calls
    await createCall(shop, {
      answeredBy: 'ai',
      startedAt: phoenix('2026-10-05T10:00'),
      transferredAt: phoenix('2026-10-05T10:05'),
    })
    await createCall(shop, {
      answeredBy: 'ai',
      startedAt: phoenix('2026-10-06T10:00'),
      safetyFlag: true,
    })

    // Out-of-range AI call
    await createCall(shop, {
      answeredBy: 'ai',
      startedAt: phoenix('2026-09-30T10:00'),
    })

    const res = await getRecovery(cookie, { from: '2026-10-01', to: '2026-10-31' }).expect(200)

    expect(res.body).toEqual({
      from: '2026-10-01',
      to: '2026-10-31',
      missedCalls: 6,
      handledByTextBack: 3,
      handledByAi: 2,
      jobsBooked: 0,
      revenueCents: 0,
    })
  })

  it('counts recovered jobs and paid invoice revenue accurately', async () => {
    const shop = await createShop('desert')
    const cookie = await owner(shop)

    // In-range recovered jobs
    const job1 = await createJob(shop, {
      source: 'text_back',
      bookedAt: phoenix('2026-10-05T10:00'),
    })
    await createInvoice(shop, job1.id, 'paid', 12000)

    const job2 = await createJob(shop, {
      source: 'ai',
      bookedAt: phoenix('2026-10-31T23:00'),
    })
    await createInvoice(shop, job2.id, 'paid', 8900)

    const job3 = await createJob(shop, {
      source: 'recovery_text',
      bookedAt: phoenix('2026-10-10T10:00'),
    })
    await createInvoice(shop, job3.id, 'open', 5000)

    const job4 = await createJob(shop, {
      source: 'ai',
      bookedAt: phoenix('2026-10-12T10:00'),
    })
    await createInvoice(shop, job4.id, 'void', 7000)

    await createJob(shop, {
      source: 'text_back',
      bookedAt: phoenix('2026-10-15T10:00'),
    })

    // Cancelled recovered job in range
    const jobCancelled = await createJob(shop, {
      source: 'text_back',
      status: 'cancelled',
      bookedAt: phoenix('2026-10-16T10:00'),
    })
    await createInvoice(shop, jobCancelled.id, 'paid', 9000)

    // Held job (no bookedAt)
    await createJob(shop, {
      source: 'ai',
      status: 'held',
      holdExpiresAt: phoenix('2026-10-20T10:00'),
      bookedAt: null,
    })

    // Out-of-range recovered job
    const jobOutOfRange = await createJob(shop, {
      source: 'recovery_text',
      bookedAt: phoenix('2026-09-30T23:30'),
    })
    await createInvoice(shop, jobOutOfRange.id, 'paid', 11000)

    // Web and office jobs in range
    const jobWeb = await createJob(shop, {
      source: 'web',
      bookedAt: phoenix('2026-10-18T10:00'),
    })
    await createInvoice(shop, jobWeb.id, 'paid', 15000)

    const jobOffice = await createJob(shop, {
      source: 'office',
      bookedAt: phoenix('2026-10-19T10:00'),
    })
    await createInvoice(shop, jobOffice.id, 'paid', 20000)

    const res = await getRecovery(cookie, { from: '2026-10-01', to: '2026-10-31' }).expect(200)

    expect(res.body).toEqual({
      from: '2026-10-01',
      to: '2026-10-31',
      missedCalls: 0,
      handledByTextBack: 0,
      handledByAi: 0,
      jobsBooked: 5,
      revenueCents: 20900,
    })
  })

  it('keeps contractors isolated', async () => {
    const shop1 = await createShop('desert')
    const shop2 = await createShop('cool')
    const cookie1 = await owner(shop1)

    // Data on shop2
    const call = await createCall(shop2, { startedAt: phoenix('2026-10-10T10:00') })
    await createTextBack(shop2, call.id, 'sent')
    await createCall(shop2, { answeredBy: 'ai', startedAt: phoenix('2026-10-11T10:00') })
    const job = await createJob(shop2, {
      source: 'text_back',
      bookedAt: phoenix('2026-10-12T10:00'),
    })
    await createInvoice(shop2, job.id, 'paid', 15000)

    const res = await getRecovery(cookie1, { from: '2026-10-01', to: '2026-10-31' }).expect(200)

    expect(res.body).toEqual({
      from: '2026-10-01',
      to: '2026-10-31',
      missedCalls: 0,
      handledByTextBack: 0,
      handledByAi: 0,
      jobsBooked: 0,
      revenueCents: 0,
    })
  })

  it('returns zeros for an empty range', async () => {
    const shop = await createShop('desert')
    const cookie = await owner(shop)

    const res = await getRecovery(cookie, { from: '2026-10-06', to: '2026-10-06' }).expect(200)

    expect(res.body).toEqual({
      from: '2026-10-06',
      to: '2026-10-06',
      missedCalls: 0,
      handledByTextBack: 0,
      handledByAi: 0,
      jobsBooked: 0,
      revenueCents: 0,
    })
  })
})

describe('GET /api/analytics/recovery/weekly', () => {
  function getWeekly(cookie?: string, query: Record<string, string> = {}) {
    const req = request(app).get('/api/analytics/recovery/weekly').query(query)
    return cookie ? req.set('Cookie', cookie) : req
  }

  // Wednesday Oct 7, 2026, 11 AM in Phoenix: this week started Monday Oct 5. Only Date is
  // faked, so the database and the HTTP server keep their real timers.
  afterEach(() => {
    vi.useRealTimers()
  })
  function todayIsOct7() {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-07T18:00:00Z'))
  }

  it('gives 12 weeks oldest first, ending with this week, empty weeks as zeros', async () => {
    const shop = await createShop('desert')
    const cookie = await owner(shop)
    todayIsOct7()

    const res = await getWeekly(cookie).expect(200)

    expect(res.body.weeks).toHaveLength(12)
    expect(res.body.weeks[0]).toEqual({ weekStart: '2026-07-20', jobsBooked: 0, revenueCents: 0 })
    expect(res.body.weeks[11]).toEqual({ weekStart: '2026-10-05', jobsBooked: 0, revenueCents: 0 })
  })

  it('puts a job in the local week it was booked, with its paid revenue', async () => {
    const shop = await createShop('desert')
    const cookie = await owner(shop)
    // Sunday 23:30 in Phoenix is already Monday in UTC: it still belongs to the week before.
    const sunday = await createJob(shop, {
      source: 'text_back',
      bookedAt: phoenix('2026-10-04T23:30:00'),
    })
    await createInvoice(shop, sunday.id, 'paid', 15000)
    const monday = await createJob(shop, { source: 'ai', bookedAt: phoenix('2026-10-05T08:00:00') })
    await createInvoice(shop, monday.id, 'open', 9000) // not paid yet: $0
    // Not recovered, cancelled, or before the 12 weeks: never counted.
    await createJob(shop, { source: 'web', bookedAt: phoenix('2026-10-05T09:00:00') })
    await createJob(shop, {
      source: 'ai',
      status: 'cancelled',
      bookedAt: phoenix('2026-10-05T09:00:00'),
    })
    await createJob(shop, { source: 'ai', bookedAt: phoenix('2026-07-19T12:00:00') })
    todayIsOct7()

    const res = await getWeekly(cookie).expect(200)

    const byWeek = Object.fromEntries(
      res.body.weeks.map((week: { weekStart: string }) => [week.weekStart, week]),
    )
    expect(byWeek['2026-09-28']).toMatchObject({ jobsBooked: 1, revenueCents: 15000 })
    expect(byWeek['2026-10-05']).toMatchObject({ jobsBooked: 1, revenueCents: 0 })
    const total = res.body.weeks.reduce(
      (sum: number, week: { jobsBooked: number }) => sum + week.jobsBooked,
      0,
    )
    expect(total).toBe(2)
  })

  it('takes a number of weeks from 1 to 26', async () => {
    const shop = await createShop('desert')
    const cookie = await owner(shop)
    todayIsOct7()

    const res = await getWeekly(cookie, { weeks: '1' }).expect(200)
    expect(res.body.weeks).toEqual([{ weekStart: '2026-10-05', jobsBooked: 0, revenueCents: 0 }])
    await getWeekly(cookie, { weeks: '26' }).expect(200)
    await getWeekly(cookie, { weeks: '0' }).expect(400)
    await getWeekly(cookie, { weeks: '27' }).expect(400)
  })

  it('is for the owner only', async () => {
    await getWeekly().expect(401)
    const shop = await createShop('desert')
    await getWeekly(shop.cookie).expect(403)
  })
})
