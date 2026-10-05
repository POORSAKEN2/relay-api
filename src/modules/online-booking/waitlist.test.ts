import { randomBytes } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createJob, createShop, resetDb } from '../../../test/helpers.ts'
import { createApp } from '../../app.ts'
import { db } from '../../db/client.ts'
import {
  arrivalWindows,
  consentEvents,
  customers,
  jobs,
  messages,
  serviceAreaZips,
  tenants,
  waitlistEntries,
} from '../../db/schema.ts'
import { weekdayOf } from '../../lib/labels.ts'
import { hashLinkToken } from '../../lib/link-token.ts'
import { sendWaitlistOffers } from './waitlist.service.ts'

vi.mock('../../realtime/index.ts', () => ({ emitToTenant: vi.fn() }))

const app = createApp()

beforeEach(async () => {
  await resetDb()
})

function get(path: string, slug = 'desert') {
  return request(app).get(`/api/online-booking/${path}`).set('X-Tenant-Host', `${slug}.localhost`)
}

function post(path: string, body: Record<string, unknown>, slug = 'desert') {
  return request(app)
    .post(`/api/online-booking/${path}`)
    .set('X-Tenant-Host', `${slug}.localhost`)
    .send(body)
}

// A timezone where it is about noon right now: quiet hours (9 PM–8 AM) never get in the way,
// and today still has its afternoon ahead.
function middayTimezone() {
  const offset = 12 - new Date().getUTCHours() // local = UTC + offset
  if (offset === 0) return 'Etc/UTC'
  // Etc/GMT names count the other way round: Etc/GMT-5 is UTC+5.
  return offset > 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`
}

// The local date `days` from today in `timezone`, e.g. '2026-10-06'.
function localDate(timezone: string, days: number) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(
    new Date(Date.now() + days * 86_400_000),
  )
}

// The moment a local date and time happen in `timezone`.
async function localMoment(timezone: string, date: string, time: string) {
  const result = await db.execute<{ at: string }>(sql`
    select to_char(
      ((${date}::date + ${time}::time) at time zone ${timezone}) at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS"Z"'
    ) as at
  `)
  return new Date(result.rows[0].at)
}

// A contractor serving 85201 where it is about noon, with one arrival window, 8–12 with room for
// 1 job, on the weekday two days from now. In the next two weeks that window opens on two dates:
// `soon` (in 2 days) and `later` (in 9 days).
async function createWaitlistShop(slug = 'desert') {
  const shop = await createShop(slug)
  const timezone = middayTimezone()
  await db.update(tenants).set({ timezone }).where(eq(tenants.id, shop.tenant.id))
  await db.insert(serviceAreaZips).values({ tenantId: shop.tenant.id, zip: '85201' })
  await db.delete(arrivalWindows).where(eq(arrivalWindows.tenantId, shop.tenant.id))
  const soon = localDate(timezone, 2)
  const [window] = await db
    .insert(arrivalWindows)
    .values({
      tenantId: shop.tenant.id,
      weekday: weekdayOf(soon),
      startsAt: '08:00',
      endsAt: '12:00',
      jobCap: 1,
    })
    .returning()
  return { ...shop, timezone, window, soon, later: localDate(timezone, 9) }
}

type WaitlistShop = Awaited<ReturnType<typeof createWaitlistShop>>

// Joins the waitlist the way the booking page does.
async function join(
  shop: WaitlistShop,
  who: { name: string; phone: string; vulnerableOccupant?: boolean },
) {
  await post(
    'waitlist',
    { serviceId: shop.service.id, zip: '85201', vulnerableOccupant: false, consent: true, ...who },
    shop.tenant.slug,
  ).expect(201)
}

// A job in the window on `date`, so its place isn't free. Returns the job.
async function fillPlace(shop: WaitlistShop, date: string, startsAt = '08:00', endsAt = '12:00') {
  return createJob(shop, {
    windowStartsAt: await localMoment(shop.timezone, date, startsAt),
    windowEndsAt: await localMoment(shop.timezone, date, endsAt),
  })
}

function entries() {
  return db.select().from(waitlistEntries).orderBy(waitlistEntries.createdAt)
}

function offerTexts() {
  return db
    .select()
    .from(messages)
    .where(eq(messages.kind, 'waitlist_offer'))
    .orderBy(messages.createdAt)
}

// The link token in an offer text.
function tokenIn(body: string) {
  return /\?offer=([\w-]+)/.exec(body)![1]
}

function bookingBody(shop: WaitlistShop, overrides: Record<string, unknown> = {}) {
  return {
    serviceId: shop.service.id,
    date: shop.soon,
    windowId: shop.window.id,
    problem: 'No cooling since last night',
    systemType: 'central_ac',
    name: 'Sam Reed',
    phone: '(480) 555-0199',
    street: '4 Cactus Rd',
    city: 'Mesa',
    state: 'az',
    zip: '85201',
    consent: true,
    ...overrides,
  }
}

// An open offer straight in the database, for the hold's tests (before the job exists).
async function insertOffer(shop: WaitlistShop, date: string, expiresInMinutes = 30) {
  const [entry] = await db
    .insert(waitlistEntries)
    .values({
      tenantId: shop.tenant.id,
      customerId: shop.customer.id,
      serviceId: shop.service.id,
      zip: '85201',
      status: 'offered',
      offerWindowId: shop.window.id,
      offerDate: date,
      offerWindowStartsAt: await localMoment(shop.timezone, date, '08:00'),
      offerExpiresAt: new Date(Date.now() + expiresInMinutes * 60_000),
      offerLinkHash: hashLinkToken(randomBytes(18).toString('base64url')),
    })
    .returning()
  return entry
}

describe('waitlist_entries', () => {
  it('gives a new entry 14 days and no missed offers', async () => {
    const shop = await createWaitlistShop()
    await join(shop, { name: 'Ann Early', phone: '(480) 555-0101' })

    const [entry] = await entries()
    expect(entry).toMatchObject({ status: 'waiting', offersMissed: 0, offerLinkHash: null })
    const days = (entry.endsAt.getTime() - entry.createdAt.getTime()) / 86_400_000
    expect(days).toBeCloseTo(14, 2)
  })

  it('refuses an offered entry without its offer', async () => {
    const shop = await createWaitlistShop()
    await expect(
      db.insert(waitlistEntries).values({
        tenantId: shop.tenant.id,
        customerId: shop.customer.id,
        serviceId: shop.service.id,
        zip: '85201',
        status: 'offered',
      }),
    ).rejects.toMatchObject({ cause: { constraint: 'waitlist_entries_offer_complete' } })
  })
})

describe('the hold', () => {
  it('hides a held place from the calendar', async () => {
    const shop = await createWaitlistShop()
    await insertOffer(shop, shop.soon)

    const res = await get('windows').expect(200)
    expect(res.body.days.map((day: { date: string }) => day.date)).toEqual([shop.later])
  })

  it('refuses to book a held place for anyone else', async () => {
    const shop = await createWaitlistShop()
    await insertOffer(shop, shop.soon)

    const res = await post('bookings', bookingBody(shop)).expect(409)
    expect(res.body.error.code).toBe('window_full')
  })

  it('frees the place the moment the offer runs out', async () => {
    const shop = await createWaitlistShop()
    await insertOffer(shop, shop.soon, -1)

    await post('bookings', bookingBody(shop)).expect(201)
  })
})

// Makes every open offer run out now, as if 30 minutes had passed.
async function runOut() {
  await db
    .update(waitlistEntries)
    .set({ offerExpiresAt: new Date(Date.now() - 60_000) })
    .where(eq(waitlistEntries.status, 'offered'))
}

describe('sendWaitlistOffers', () => {
  it('offers the soonest open place to the first in line, priority first', async () => {
    const shop = await createWaitlistShop()
    await join(shop, { name: 'Ann Early', phone: '(480) 555-0101' })
    await join(shop, { name: 'Bo Priority', phone: '(480) 555-0102', vulnerableOccupant: true })
    await fillPlace(shop, shop.later)

    expect(await sendWaitlistOffers()).toEqual({ offered: 1, expired: 0 })

    const [ann, bo] = await entries()
    expect(ann).toMatchObject({ status: 'waiting', offerDate: null })
    expect(bo).toMatchObject({
      status: 'offered',
      offerDate: shop.soon,
      offerWindowId: shop.window.id,
    })
    expect(bo.offerExpiresAt!.getTime() - Date.now()).toBeGreaterThan(29 * 60_000)
    const [text] = await offerTexts()
    expect(text).toMatchObject({
      contact: '+14805550102',
      customerId: bo.customerId,
      status: 'queued',
    })
    expect(text.body).toMatch(
      /^desert HVAC: a time opened up: \w{3}, \w{3} \d{1,2}, 8 AM - 12 PM\. It's yours for 30 minutes: https:\/\/desert\.localhost\/\?offer=[\w-]+ Reply STOP to opt out\.$/,
    )
    expect(hashLinkToken(tokenIn(text.body))).toBe(bo.offerLinkHash)
  })

  it('offers each open place once, soonest first, to whoever joined first', async () => {
    const shop = await createWaitlistShop()
    await join(shop, { name: 'Ann Early', phone: '(480) 555-0101' })
    await join(shop, { name: 'Cy Middle', phone: '(480) 555-0103' })
    await join(shop, { name: 'Di Late', phone: '(480) 555-0104' })

    expect(await sendWaitlistOffers()).toEqual({ offered: 2, expired: 0 })
    const [ann, cy, di] = await entries()
    expect(ann.offerDate).toBe(shop.soon)
    expect(cy.offerDate).toBe(shop.later)
    expect(di.status).toBe('waiting')

    // Both places are held now: nothing more to offer.
    expect(await sendWaitlistOffers()).toEqual({ offered: 0, expired: 0 })
    expect(await offerTexts()).toHaveLength(2)
  })

  it('offers no place that starts within 2 hours', async () => {
    const shop = await createWaitlistShop()
    await join(shop, { name: 'Ann Early', phone: '(480) 555-0101' })
    await fillPlace(shop, shop.soon)
    await fillPlace(shop, shop.later)
    // It is about noon there: today's 1 PM window starts within the hour. Its date a week on
    // is taken.
    const today = localDate(shop.timezone, 0)
    const values = { tenantId: shop.tenant.id, weekday: weekdayOf(today), jobCap: 1 }
    await db.insert(arrivalWindows).values({ ...values, startsAt: '13:00', endsAt: '15:00' })
    await fillPlace(shop, localDate(shop.timezone, 7), '13:00', '15:00')

    expect(await sendWaitlistOffers()).toEqual({ offered: 0, expired: 0 })

    // 3 PM today is more than 2 hours off.
    const [later] = await db
      .insert(arrivalWindows)
      .values({ ...values, startsAt: '15:00', endsAt: '17:00' })
      .returning()
    expect(await sendWaitlistOffers()).toEqual({ offered: 1, expired: 0 })
    const [ann] = await entries()
    expect(ann).toMatchObject({ offerDate: today, offerWindowId: later.id })
  })

  it('makes no offers in quiet hours', async () => {
    const shop = await createWaitlistShop()
    await join(shop, { name: 'Ann Early', phone: '(480) 555-0101' })
    // It is about noon there.
    await db
      .update(tenants)
      .set({ quietHoursStart: '11:00', quietHoursEnd: '13:00' })
      .where(eq(tenants.id, shop.tenant.id))

    expect(await sendWaitlistOffers()).toEqual({ offered: 0, expired: 0 })
    expect(await offerTexts()).toEqual([])
  })

  it('makes no offers for a suspended contractor', async () => {
    const shop = await createWaitlistShop()
    await join(shop, { name: 'Ann Early', phone: '(480) 555-0101' })
    await db.update(tenants).set({ status: 'suspended' }).where(eq(tenants.id, shop.tenant.id))

    expect(await sendWaitlistOffers()).toEqual({ offered: 0, expired: 0 })
  })

  it('skips a homeowner with no phone any more', async () => {
    const shop = await createWaitlistShop()
    await join(shop, { name: 'Ann Early', phone: '(480) 555-0101' })
    await join(shop, { name: 'Cy Middle', phone: '(480) 555-0103' })
    await fillPlace(shop, shop.later)
    await db.update(customers).set({ phone: null }).where(eq(customers.phone, '+14805550101'))

    expect(await sendWaitlistOffers()).toEqual({ offered: 1, expired: 0 })
    const [ann, cy] = await entries()
    expect(ann.status).toBe('waiting')
    expect(cy.status).toBe('offered')
  })

  it('never lets an offer and a booking both take the last place', async () => {
    const shop = await createWaitlistShop()
    await join(shop, { name: 'Ann Early', phone: '(480) 555-0101' })
    await fillPlace(shop, shop.later)
    const soonStart = await localMoment(shop.timezone, shop.soon, '08:00')

    await Promise.all([sendWaitlistOffers(), post('bookings', bookingBody(shop))])

    const booked = await db.select().from(jobs).where(eq(jobs.windowStartsAt, soonStart))
    const held = (await entries()).filter((entry) => entry.status === 'offered')
    expect(booked.length + held.length).toBe(1)
  })

  describe('an offer that runs out', () => {
    it('keeps the homeowner in line and passes the place to the next one', async () => {
      const shop = await createWaitlistShop()
      await join(shop, { name: 'Ann Early', phone: '(480) 555-0101' })
      await join(shop, { name: 'Cy Middle', phone: '(480) 555-0103' })
      await fillPlace(shop, shop.later)
      await sendWaitlistOffers()
      await runOut()

      expect(await sendWaitlistOffers()).toEqual({ offered: 1, expired: 1 })
      const [ann, cy] = await entries()
      expect(ann).toMatchObject({ status: 'waiting', offersMissed: 1, offerLinkHash: null })
      expect(cy).toMatchObject({ status: 'offered', offerDate: shop.soon })
    })

    it('takes the homeowner off after 2, with one last text', async () => {
      const shop = await createWaitlistShop()
      await join(shop, { name: 'Ann Early', phone: '(480) 555-0101' })
      const later = await fillPlace(shop, shop.later)
      await sendWaitlistOffers()
      await runOut()
      // The same place is never offered to them twice.
      expect(await sendWaitlistOffers()).toEqual({ offered: 0, expired: 1 })

      // Another place opens: their second offer.
      await db.update(jobs).set({ status: 'cancelled' }).where(eq(jobs.id, later.id))
      expect(await sendWaitlistOffers()).toEqual({ offered: 1, expired: 0 })
      await runOut()

      expect(await sendWaitlistOffers()).toEqual({ offered: 0, expired: 1 })
      const [ann] = await entries()
      expect(ann).toMatchObject({ status: 'expired', offersMissed: 2, offerLinkHash: null })
      const texts = await offerTexts()
      expect(texts).toHaveLength(3)
      expect(texts[2].body).toBe(
        "desert HVAC: we've taken you off the waitlist. Book anytime: https://desert.localhost/ Reply STOP to opt out.",
      )
    })
  })

  describe('closing entries', () => {
    it('takes a homeowner off after 14 days, without a text', async () => {
      const shop = await createWaitlistShop()
      await join(shop, { name: 'Ann Early', phone: '(480) 555-0101' })
      await db.update(waitlistEntries).set({ endsAt: new Date(Date.now() - 60_000) })

      expect(await sendWaitlistOffers()).toEqual({ offered: 0, expired: 0 })
      const [ann] = await entries()
      expect(ann.status).toBe('expired')
      expect(await offerTexts()).toEqual([])
    })

    it('marks the entry booked once the homeowner books any visit', async () => {
      const shop = await createWaitlistShop()
      await join(shop, { name: 'Ann Early', phone: '(480) 555-0101' })
      await post(
        'bookings',
        bookingBody(shop, { name: 'Ann Early', phone: '(480) 555-0101' }),
      ).expect(201)

      expect(await sendWaitlistOffers()).toEqual({ offered: 0, expired: 0 })
      const [ann] = await entries()
      expect(ann.status).toBe('booked')
    })

    it('removes a homeowner who opted out of texts', async () => {
      const shop = await createWaitlistShop()
      await join(shop, { name: 'Ann Early', phone: '(480) 555-0101' })
      // Recorded by the office here: a STOP reply would need the text it answered.
      await db.insert(consentEvents).values({
        tenantId: shop.tenant.id,
        contact: '+14805550101',
        channel: 'sms',
        granted: false,
        source: 'office',
      })

      expect(await sendWaitlistOffers()).toEqual({ offered: 0, expired: 0 })
      const [ann] = await entries()
      expect(ann.status).toBe('removed')
      expect(await offerTexts()).toEqual([])
    })
  })
})
