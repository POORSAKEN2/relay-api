import { eq, sql } from 'drizzle-orm'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createJob, createShop, resetDb } from '../../../test/helpers.ts'
import { createApp } from '../../app.ts'
import { db } from '../../db/client.ts'
import { arrivalWindows, serviceAreaZips, tenants, waitlistEntries } from '../../db/schema.ts'
import { weekdayOf } from '../../lib/labels.ts'

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
