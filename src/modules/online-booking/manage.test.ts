import { eq } from 'drizzle-orm'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createJob, createShop, resetDb, type Shop, TUESDAY } from '../../../test/helpers.ts'
import { createApp } from '../../app.ts'
import { db } from '../../db/client.ts'
import { auditEvents, consentEvents, customers, jobs, messages } from '../../db/schema.ts'
import { hashLinkToken } from '../../lib/link-token.ts'
import { emitToTenant } from '../../realtime/index.ts'

vi.mock('../../realtime/index.ts', () => ({ emitToTenant: vi.fn() }))

const app = createApp()
const TOKEN = 'test-manage-token-0000001'
const WEDNESDAY = '2030-01-09'

beforeEach(async () => {
  await resetDb()
  vi.mocked(emitToTenant).mockClear()
})

// The manage page has no sign-in: the token finds the visit, the address the contractor.
function get(token = TOKEN, slug = 'desert') {
  return request(app)
    .get(`/api/online-booking/manage/${token}`)
    .set('X-Tenant-Host', `${slug}.localhost`)
}

function post(path: string, body: object = {}) {
  return request(app)
    .post(`/api/online-booking/manage/${TOKEN}/${path}`)
    .set('X-Tenant-Host', 'desert.localhost')
    .send(body)
}

// Maria's visit on Tuesday 8 AM–12 PM, with a link. She agreed to texts and gave an email,
// unless `consent` is false.
async function visitWithLink(
  shop: Shop,
  values: Parameters<typeof createJob>[1] = {},
  { consent = true } = {},
) {
  await db
    .update(customers)
    .set({ email: 'maria@example.com' })
    .where(eq(customers.id, shop.customer.id))
  if (consent) {
    await db.insert(consentEvents).values({
      tenantId: shop.tenant.id,
      contact: '+16025550111',
      channel: 'sms',
      granted: true,
      source: 'booking_form',
    })
  }
  return createJob(shop, { source: 'web', manageLinkHash: hashLinkToken(TOKEN), ...values })
}

async function reload(jobId: string) {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId))
  return job
}

const sentSummary = async () =>
  (await db.select().from(messages)).map((m) => [m.channel, m.kind, m.contact]).sort()

describe('GET /api/online-booking/manage/:token', () => {
  it('shows the visit, and that it can still be changed', async () => {
    const shop = await createShop('desert')
    await visitWithLink(shop)

    expect((await get().expect(200)).body).toEqual({
      status: 'booked',
      serviceName: 'AC repair',
      date: TUESDAY,
      dayLabel: 'Tue, Jan 8',
      windowLabel: '8 AM–12 PM',
      address: '12 Palm St, Phoenix, AZ 85004',
      canChange: true,
      contactPhone: '(480) 555-0100',
    })
  })

  it('can’t be changed once the technician is on the way', async () => {
    const shop = await createShop('desert')
    await visitWithLink(shop, { status: 'en_route', technicianId: shop.mike.id })

    expect((await get().expect(200)).body).toMatchObject({ status: 'en_route', canChange: false })
  })

  it('can’t be changed once the window started', async () => {
    const shop = await createShop('desert')
    await visitWithLink(shop, { at: '2020-01-07 08:00' })

    expect((await get().expect(200)).body.canChange).toBe(false)
  })

  it('doesn’t work with a wrong token or on another contractor’s address', async () => {
    const shop = await createShop('desert')
    await createShop('other')
    await visitWithLink(shop)

    const wrong = await get('not-the-token').expect(404)
    expect(wrong.body.error).toEqual({
      code: 'not_found',
      message: 'This link doesn’t work anymore. Call (480) 555-0100 to make changes.',
    })
    await get(TOKEN, 'other').expect(404)
  })
})

describe('POST /api/online-booking/manage/:token/reschedule', () => {
  it('moves the visit, tells everyone and keeps the technician', async () => {
    const shop = await createShop('desert')
    const job = await visitWithLink(shop, {
      technicianId: shop.mike.id,
      etaAt: new Date('2030-01-08T16:00:00Z'),
    })

    const res = await post('reschedule', { date: WEDNESDAY, windowId: shop.wedMorning.id }).expect(
      200,
    )

    expect(res.body).toMatchObject({ date: WEDNESDAY, dayLabel: 'Wed, Jan 9', canChange: true })
    expect(await reload(job.id)).toMatchObject({
      windowStartsAt: new Date('2030-01-09T15:00:00Z'),
      technicianId: shop.mike.id,
      etaAt: null,
      status: 'booked',
    })
    const [audit] = await db.select().from(auditEvents)
    expect(audit).toMatchObject({ actorType: 'homeowner', action: 'job.moved', entityId: job.id })
    expect(emitToTenant).toHaveBeenCalledWith(shop.tenant.id, 'job.assigned', {
      jobId: job.id,
      dates: [TUESDAY, WEDNESDAY],
    })

    expect(await sentSummary()).toEqual([
      ['email', 'booking_changed', 'maria@example.com'],
      ['sms', 'booking_changed', '+16025550111'],
      ['sms', 'job_assigned', shop.mike.phone],
    ])
    const sent = await db.select().from(messages)
    const homeowner = sent.find((m) => m.channel === 'sms' && m.kind === 'booking_changed')!
    expect(homeowner.body).toBe(
      `desert HVAC: your visit is moved to Wed, Jan 9, 8 AM - 12 PM. Change or cancel: https://desert.localhost/manage/${TOKEN}`,
    )
    expect(sent.find((m) => m.kind === 'job_assigned')!.body).toContain('Job changed')
    expect(sent.find((m) => m.channel === 'email')!.subject).toBe(
      'Your visit is moved to Wed, Jan 9',
    )
  })

  it('does nothing when the time is the same, as after a double tap', async () => {
    const shop = await createShop('desert')
    await visitWithLink(shop)

    await post('reschedule', { date: TUESDAY, windowId: shop.tueMorning.id }).expect(200)

    expect(await db.select().from(auditEvents)).toHaveLength(0)
    expect(await db.select().from(messages)).toHaveLength(0)
    expect(emitToTenant).not.toHaveBeenCalled()
  })

  it('refuses a full window and changes nothing', async () => {
    const shop = await createShop('desert')
    const job = await visitWithLink(shop)
    await createJob(shop, { at: `${WEDNESDAY} 08:00` })
    await createJob(shop, { at: `${WEDNESDAY} 08:00` })

    const res = await post('reschedule', { date: WEDNESDAY, windowId: shop.wedMorning.id }).expect(
      409,
    )

    expect(res.body.error.code).toBe('window_full')
    expect((await reload(job.id)).windowStartsAt).toEqual(new Date('2030-01-08T15:00:00Z'))
    expect(await db.select().from(messages)).toHaveLength(0)
  })

  it('refuses once the technician is on the way', async () => {
    const shop = await createShop('desert')
    await visitWithLink(shop, { status: 'en_route', technicianId: shop.mike.id })

    const res = await post('reschedule', { date: WEDNESDAY, windowId: shop.wedMorning.id }).expect(
      409,
    )

    expect(res.body.error).toEqual({
      code: 'cannot_change',
      message: 'Your visit can’t be changed online anymore. Call (480) 555-0100.',
    })
    expect(await db.select().from(messages)).toHaveLength(0)
  })

  it('still moves the visit of a homeowner with no phone on file, texting nobody', async () => {
    const shop = await createShop('desert')
    const job = await visitWithLink(shop, {}, { consent: false })
    await db.update(customers).set({ phone: null }).where(eq(customers.id, shop.customer.id))

    await post('reschedule', { date: WEDNESDAY, windowId: shop.wedMorning.id }).expect(200)

    expect((await reload(job.id)).windowStartsAt).toEqual(new Date('2030-01-09T15:00:00Z'))
    expect(await sentSummary()).toEqual([['email', 'booking_changed', 'maria@example.com']])
  })

  it('refuses a body without a window', async () => {
    const shop = await createShop('desert')
    await visitWithLink(shop)

    const res = await post('reschedule', { date: WEDNESDAY, windowId: 'nope' }).expect(400)
    expect(res.body.error.details).toEqual({ windowId: ['Pick an arrival window'] })
  })
})

describe('POST /api/online-booking/manage/:token/cancel', () => {
  it('cancels the visit, tells everyone, and the link stops working', async () => {
    const shop = await createShop('desert')
    const job = await visitWithLink(shop, { technicianId: shop.mike.id })

    expect((await post('cancel').expect(200)).body).toEqual({ status: 'cancelled' })

    expect(await reload(job.id)).toMatchObject({ status: 'cancelled', manageLinkHash: null })
    const [audit] = await db.select().from(auditEvents)
    expect(audit).toMatchObject({
      actorType: 'homeowner',
      actorUserId: null,
      action: 'job.status_changed',
      data: { from: 'booked', to: 'cancelled' },
    })
    expect(emitToTenant).toHaveBeenCalledWith(shop.tenant.id, 'job.status_changed', {
      jobId: job.id,
      dates: [TUESDAY],
    })

    expect(await sentSummary()).toEqual([
      ['email', 'booking_changed', 'maria@example.com'],
      ['sms', 'booking_changed', '+16025550111'],
      ['sms', 'job_assigned', shop.mike.phone],
    ])
    const sent = await db.select().from(messages)
    expect(sent.find((m) => m.channel === 'sms' && m.kind === 'booking_changed')!.body).toBe(
      'desert HVAC: your visit on Tue, Jan 8 is cancelled. Book again: https://desert.localhost/',
    )
    expect(sent.find((m) => m.kind === 'job_assigned')!.body).toBe(
      'desert HVAC: Job cancelled. AC repair in Phoenix, Tue, Jan 8, 8 AM-12 PM.',
    )

    await get().expect(404)
  })

  it('keeps the text from a homeowner who didn’t agree to texts', async () => {
    const shop = await createShop('desert')
    await visitWithLink(shop, {}, { consent: false })

    await post('cancel').expect(200)

    const [text] = await db.select().from(messages).where(eq(messages.channel, 'sms'))
    expect(text).toMatchObject({ status: 'blocked', blockedReason: 'no_consent' })
  })

  it('refuses once the window started', async () => {
    const shop = await createShop('desert')
    const job = await visitWithLink(shop, { at: '2020-01-07 08:00' })

    const res = await post('cancel').expect(409)

    expect(res.body.error.code).toBe('cannot_change')
    expect((await reload(job.id)).status).toBe('booked')
    expect(await db.select().from(messages)).toHaveLength(0)
  })
})
