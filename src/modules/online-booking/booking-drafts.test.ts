import { eq } from 'drizzle-orm'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createJob, createShop, resetDb, type Shop, TUESDAY } from '../../../test/helpers.ts'
import { createApp } from '../../app.ts'
import { db } from '../../db/client.ts'
import {
  auditEvents,
  bookingDrafts,
  consentEvents,
  jobs,
  messages,
  serviceAreaZips,
  tenants,
} from '../../db/schema.ts'
import { CONSENT_WORDING, sendRecoveryTexts } from './online-booking.service.ts'

vi.mock('../../realtime/index.ts', () => ({ emitToTenant: vi.fn() }))

const app = createApp()

beforeEach(async () => {
  await resetDb()
})

// The booking page has no sign-in: the contractor comes from the web address.
function call(method: 'get' | 'post' | 'patch', path: string, slug = 'desert') {
  return request(app)
    [method](`/api/online-booking/${path}`)
    .set('X-Tenant-Host', `${slug}.localhost`)
}

// A shop that serves Mesa (85201) and downtown Phoenix (85004).
async function createServingShop(slug = 'desert') {
  const shop = await createShop(slug)
  await db
    .insert(serviceAreaZips)
    .values(['85004', '85201'].map((zip) => ({ tenantId: shop.tenant.id, zip })))
  return shop
}

function draftBody(overrides: Record<string, unknown> = {}) {
  return { name: 'Sam Reed', phone: '(480) 555-0199', zip: '85201', consent: true, ...overrides }
}

function bookingBody(shop: Shop, overrides: Record<string, unknown> = {}) {
  return {
    serviceId: shop.service.id,
    date: TUESDAY,
    windowId: shop.tueMorning.id,
    problem: 'No cooling since last night',
    systemType: 'central_ac',
    name: 'Sam Reed',
    phone: '(480) 555-0199',
    street: '4 Cactus Rd',
    city: 'Mesa',
    state: 'AZ',
    zip: '85201',
    consent: true,
    ...overrides,
  }
}

describe('POST /api/online-booking/drafts', () => {
  it('saves who started a booking, with their consent', async () => {
    const shop = await createServingShop()

    const res = await call('post', 'drafts').send(draftBody()).expect(201)
    expect(res.body.token).toMatch(/^[0-9a-f]{64}$/)

    const [draft] = await db.select().from(bookingDrafts)
    expect(draft).toMatchObject({
      tenantId: shop.tenant.id,
      token: res.body.token,
      name: 'Sam Reed',
      phone: '+14805550199',
      zip: '85201',
      smsConsent: true,
      answers: {},
      recoveryTextedAt: null,
      bookedJobId: null,
    })

    const consent = await db.select().from(consentEvents)
    expect(consent.map((event) => event.channel).sort()).toEqual(['sms', 'voice'])
    for (const event of consent) {
      expect(event).toMatchObject({
        contact: '+14805550199',
        granted: true,
        source: 'booking_form',
        wording: CONSENT_WORDING,
        jobId: null,
      })
    }
    expect(await db.select().from(auditEvents)).toEqual([
      expect.objectContaining({
        actorType: 'homeowner',
        action: 'booking_draft.created',
        entityId: draft.id,
      }),
    ])
  })

  it('saves a draft without consent and records none', async () => {
    await createServingShop()

    await call('post', 'drafts')
      .send(draftBody({ consent: false }))
      .expect(201)

    const [draft] = await db.select().from(bookingDrafts)
    expect(draft.smsConsent).toBe(false)
    expect(await db.select().from(consentEvents)).toHaveLength(0)
  })

  it('updates the same draft when the homeowner comes back to the step', async () => {
    await createServingShop()
    const first = await call('post', 'drafts').send(draftBody()).expect(201)

    const second = await call('post', 'drafts')
      .send(
        draftBody({
          name: 'Samantha Reed',
          zip: '85004',
          consent: false,
          token: first.body.token,
        }),
      )
      .expect(201)

    expect(second.body.token).toBe(first.body.token)
    const drafts = await db.select().from(bookingDrafts)
    expect(drafts).toHaveLength(1)
    expect(drafts[0]).toMatchObject({ name: 'Samantha Reed', zip: '85004', smsConsent: false })
    // Ticked, then unticked: two rows granting and two taking it back.
    const consent = await db.select().from(consentEvents)
    expect(consent.map((event) => event.granted).sort()).toEqual([false, false, true, true])
  })

  it('refuses a ZIP code outside the service area and a bad phone number', async () => {
    await createServingShop()

    const outside = await call('post', 'drafts')
      .send(draftBody({ zip: '90210' }))
      .expect(422)
    expect(outside.body.error.code).toBe('outside_area')

    const bad = await call('post', 'drafts')
      .send(draftBody({ phone: '555' }))
      .expect(400)
    expect(bad.body.error.details.phone).toEqual(['Enter a 10-digit phone number'])
    expect(await db.select().from(bookingDrafts)).toHaveLength(0)
  })
})

describe('GET and PATCH /api/online-booking/drafts/:token', () => {
  it('saves the answers and gives the draft back', async () => {
    const shop = await createServingShop()
    const { body } = await call('post', 'drafts').send(draftBody()).expect(201)
    const [before] = await db.select().from(bookingDrafts)
    const answers = { serviceId: shop.service.id, problem: 'No cooling', systemType: 'central_ac' }

    await call('patch', `drafts/${body.token}`).send({ answers }).expect(200, { ok: true })

    const res = await call('get', `drafts/${body.token}`).expect(200)
    expect(res.body).toEqual({
      name: 'Sam Reed',
      phone: '+14805550199',
      zip: '85201',
      consent: true,
      answers,
    })
    const [after] = await db.select().from(bookingDrafts)
    expect(after.lastActivityAt.getTime()).toBeGreaterThanOrEqual(before.lastActivityAt.getTime())
  })

  it('refuses answers that are not the wizard’s', async () => {
    await createServingShop()
    const { body } = await call('post', 'drafts').send(draftBody()).expect(201)

    await call('patch', `drafts/${body.token}`)
      .send({ answers: { systemType: 'toaster' } })
      .expect(400)
  })

  it('hides a draft from an unknown token and from another contractor', async () => {
    await createServingShop()
    await createServingShop('other')
    const { body } = await call('post', 'drafts').send(draftBody()).expect(201)

    await call('get', 'drafts/nope').expect(404)
    await call('get', `drafts/${body.token}`, 'other').expect(404)
    await call('patch', `drafts/${body.token}`, 'other').send({ answers: {} }).expect(404)
  })
})

describe('POST /api/online-booking/bookings with a draft', () => {
  it('marks the draft as booked, so it can’t be resumed', async () => {
    const shop = await createServingShop()
    const { body } = await call('post', 'drafts').send(draftBody()).expect(201)

    const res = await call('post', 'bookings')
      .send(bookingBody(shop, { draftToken: body.token }))
      .expect(201)

    const [draft] = await db.select().from(bookingDrafts)
    expect(draft.bookedJobId).toBe(res.body.jobId)
    await call('get', `drafts/${body.token}`).expect(404)
  })

  it('still books when the draft token is unknown', async () => {
    const shop = await createServingShop()

    const res = await call('post', 'bookings')
      .send(bookingBody(shop, { draftToken: 'nope' }))
      .expect(201)

    const [job] = await db.select().from(jobs).where(eq(jobs.id, res.body.jobId))
    expect(job.status).toBe('booked')
  })
})

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000)

// A draft straight in the database: consent given, quiet for 90 minutes, begun 2 hours ago.
// That is one the recovery job should text.
async function insertDraft(
  shop: Shop,
  token: string,
  overrides: Partial<typeof bookingDrafts.$inferInsert> = {},
) {
  await db.insert(bookingDrafts).values({
    tenantId: shop.tenant.id,
    token,
    name: 'Sam Reed',
    phone: '+14805550199',
    zip: '85201',
    smsConsent: true,
    lastActivityAt: minutesAgo(90),
    createdAt: minutesAgo(120),
    ...overrides,
  })
}

describe('sendRecoveryTexts', () => {
  it('saves one text with a link back, and never a second one', async () => {
    const shop = await createServingShop()
    await insertDraft(shop, 'token-1')

    expect(await sendRecoveryTexts()).toBe(1)

    const saved = await db.select().from(messages)
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({
      tenantId: shop.tenant.id,
      channel: 'sms',
      direction: 'outbound',
      kind: 'abandoned_booking',
      status: 'queued',
      contact: '+14805550199',
    })
    expect(saved[0].body).toContain('desert HVAC')
    expect(saved[0].body).toContain('https://desert.localhost/?resume=token-1')
    const [draft] = await db.select().from(bookingDrafts)
    expect(draft.recoveryTextedAt).toBeInstanceOf(Date)

    expect(await sendRecoveryTexts()).toBe(0)
    expect(await db.select().from(messages)).toHaveLength(1)
  })

  it('does not text the homeowners of a suspended contractor', async () => {
    const live = await createServingShop('desert')
    const off = await createServingShop('gone')
    await insertDraft(live, 'live-token')
    await insertDraft(off, 'off-token')
    await db.update(tenants).set({ status: 'suspended' }).where(eq(tenants.id, off.tenant.id))

    expect(await sendRecoveryTexts()).toBe(1)

    const saved = await db.select().from(messages)
    expect(saved).toHaveLength(1)
    expect(saved[0].tenantId).toBe(live.tenant.id)
  })

  it('leaves alone every draft that must not be texted', async () => {
    const shop = await createServingShop()
    const job = await createJob(shop) // made just now, for the customer with phone +16025550111

    await insertDraft(shop, 'no-consent', { smsConsent: false })
    await insertDraft(shop, 'still-active', { lastActivityAt: minutesAgo(10) })
    await insertDraft(shop, 'too-old', { createdAt: minutesAgo(25 * 60) })
    await insertDraft(shop, 'booked', { bookedJobId: job.id })
    await insertDraft(shop, 'booked-by-phone', { phone: '+16025550111' })

    expect(await sendRecoveryTexts()).toBe(0)
    expect(await db.select().from(messages)).toHaveLength(0)
  })
})
