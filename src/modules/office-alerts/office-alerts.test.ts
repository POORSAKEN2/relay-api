import { eq, inArray } from 'drizzle-orm'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createShop,
  createTenant,
  createUser,
  resetDb,
  type Shop,
  TUESDAY,
  WEDNESDAY,
} from '../../../test/helpers.ts'
import { createApp } from '../../app.ts'
import { db } from '../../db/client.ts'
import { messages, serviceAreaZips, users } from '../../db/schema.ts'
import { emitToTenant } from '../../realtime/index.ts'

vi.mock('../../realtime/index.ts', () => ({ emitToTenant: vi.fn() }))

const app = createApp()

beforeEach(async () => {
  await resetDb()
  vi.mocked(emitToTenant).mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

async function createServingShop(slug = 'desert') {
  const shop = await createShop(slug)
  await db
    .insert(serviceAreaZips)
    .values(['85004', '85201'].map((zip) => ({ tenantId: shop.tenant.id, zip })))
  return shop
}

function onlineBookingBody(shop: Shop, overrides: Record<string, unknown> = {}) {
  return {
    serviceId: shop.service.id,
    date: TUESDAY,
    windowId: shop.tueMorning.id,
    problem: 'AC blowing warm air',
    systemType: 'central_ac',
    vulnerableOccupant: false,
    priorityService: false,
    name: 'Alex Diaz',
    phone: '(480) 555-0199',
    email: 'Alex@Example.com',
    street: '14 Elm St',
    unit: '',
    city: 'Phoenix',
    state: 'az',
    zip: '85004',
    consent: true,
    ...overrides,
  }
}

function officeBookingBody(shop: Shop, overrides: Record<string, unknown> = {}) {
  return {
    newCustomer: { name: 'Sam Reed', phone: '(480) 555-0199', email: 'Sam@Example.com' },
    newProperty: { street: '4 Cactus Rd', city: 'Phoenix', state: 'AZ', zip: '85004' },
    serviceId: shop.service.id,
    date: TUESDAY,
    windowId: shop.tueMorning.id,
    problem: 'No cooling since last night',
    systemType: 'central_ac',
    vulnerableOccupant: false,
    consentToTexts: true,
    ...overrides,
  }
}

function postOnlineBooking(body: Record<string, unknown>, slug = 'desert') {
  return request(app)
    .post('/api/online-booking/bookings')
    .set('X-Tenant-Host', `${slug}.localhost`)
    .send(body)
}

function postOfficeBooking(shop: Shop, body: Record<string, unknown>) {
  return request(app).post('/api/bookings').set('Cookie', shop.cookie).send(body)
}

function alertMessages() {
  return db
    .select()
    .from(messages)
    .where(inArray(messages.kind, ['new_booking_alert', 'priority_alert']))
}

describe('office alerts on booking', () => {
  it('texts the owner but not the booking office user when office staff books', async () => {
    const shop = await createServingShop('desert')
    // Office user has a phone
    await db.update(users).set({ phone: '+14805550111' }).where(eq(users.id, shop.office.id))
    // Owner with a phone
    const owner = await createUser('owner', shop.tenant.id)
    await db.update(users).set({ phone: '+14805550222' }).where(eq(users.id, owner.id))

    const res = await postOfficeBooking(shop, officeBookingBody(shop)).expect(201)

    const alerts = await alertMessages()
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toMatchObject({
      kind: 'new_booking_alert',
      contact: '+14805550222',
      toUserId: owner.id,
      jobId: res.body.jobId,
    })
    expect(alerts[0].body).toContain(`${shop.tenant.name}: New booking (by the office).`)
  })

  it('texts every active owner and office user with a phone when booked online', async () => {
    const shop = await createServingShop('desert')
    await db.update(users).set({ phone: '+14805550111' }).where(eq(users.id, shop.office.id))
    const owner = await createUser('owner', shop.tenant.id)
    await db.update(users).set({ phone: '+14805550222' }).where(eq(users.id, owner.id))

    const res = await postOnlineBooking(onlineBookingBody(shop)).expect(201)

    const alerts = await alertMessages()
    expect(alerts).toHaveLength(2)
    const contacts = alerts.map((a) => a.contact).sort()
    expect(contacts).toEqual(['+14805550111', '+14805550222'])

    for (const alert of alerts) {
      expect(alert.jobId).toBe(res.body.jobId)
      expect(alert.toUserId).toBeTruthy()
      expect(alert.body).toContain('Phoenix')
      expect(alert.body).toContain(`/dashboard?date=${TUESDAY}&job=${res.body.jobId}`)
    }
  })

  it('does not alert disabled users, users without a phone, technicians, or other contractors', async () => {
    const shop = await createServingShop('desert')
    // Active office user without phone (default)
    expect(shop.office.phone).toBeNull()

    // Disabled office user with a phone
    const disabled = await createUser('office', shop.tenant.id)
    await db
      .update(users)
      .set({ phone: '+14805550333', disabledAt: new Date() })
      .where(eq(users.id, disabled.id))

    // Active technician with a phone (shop.mike)
    expect(shop.mike.phone).toBeTruthy()

    // Another contractor's owner with a phone
    const other = await createTenant('other')
    const otherOwner = await createUser('owner', other.id)
    await db.update(users).set({ phone: '+14805550444' }).where(eq(users.id, otherOwner.id))

    await postOnlineBooking(onlineBookingBody(shop)).expect(201)

    const alerts = await alertMessages()
    expect(alerts).toHaveLength(0)
  })

  it('sends one priority_alert per recipient and no new_booking_alert for a priority booking', async () => {
    const shop = await createServingShop('desert')
    await db.update(users).set({ phone: '+14805550111' }).where(eq(users.id, shop.office.id))

    const res = await postOnlineBooking(
      onlineBookingBody(shop, { vulnerableOccupant: true }),
    ).expect(201)

    const alerts = await alertMessages()
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toMatchObject({
      kind: 'priority_alert',
      contact: '+14805550111',
      jobId: res.body.jobId,
    })
    expect(alerts[0].body).toContain(
      'PRIORITY job (online). Vulnerable person, no heat or cooling.',
    )
  })

  it('holds ordinary alert for quiet hours but sends priority alert now', async () => {
    const shop = await createServingShop('desert') // Phoenix timezone (America/Phoenix, UTC-7), quiet 21:00 to 08:00
    await db.update(users).set({ phone: '+14805550111' }).where(eq(users.id, shop.office.id))

    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2030-01-08T23:00:00-07:00'))

    // 1. Ordinary booking during quiet hours for Wednesday morning
    await postOnlineBooking(
      onlineBookingBody(shop, { date: WEDNESDAY, windowId: shop.wedMorning.id }),
    ).expect(201)
    const [ordinaryAlert] = await alertMessages()
    expect(ordinaryAlert.kind).toBe('new_booking_alert')
    expect(ordinaryAlert.sendAfter).toEqual(new Date('2030-01-09T08:00:00-07:00'))

    // Clear messages
    await db.delete(messages)

    // 2. Priority booking during quiet hours
    await postOnlineBooking(
      onlineBookingBody(shop, {
        date: WEDNESDAY,
        windowId: shop.wedMorning.id,
        vulnerableOccupant: true,
      }),
    ).expect(201)
    const [priorityAlert] = await alertMessages()
    expect(priorityAlert.kind).toBe('priority_alert')
    expect(priorityAlert.sendAfter.getTime()).toBeLessThanOrEqual(
      new Date('2030-01-08T23:00:00-07:00').getTime(),
    )
  })

  it('leaves no alert rows when a booking fails (window full)', async () => {
    const shop = await createServingShop('desert')
    await db.update(users).set({ phone: '+14805550111' }).where(eq(users.id, shop.office.id))

    // Tue morning window has cap: 2
    await postOnlineBooking(onlineBookingBody(shop)).expect(201)
    await postOnlineBooking(
      onlineBookingBody(shop, {
        name: 'Customer Two',
        phone: '+14805550299',
        email: 'two@test.local',
      }),
    ).expect(201)

    // Clear alerts from the first two successful bookings
    await db.delete(messages)

    // 3rd booking fails with window full (409)
    await postOnlineBooking(
      onlineBookingBody(shop, {
        name: 'Customer Three',
        phone: '+14805550399',
        email: 'three@test.local',
      }),
    ).expect(409)

    const alerts = await alertMessages()
    expect(alerts).toHaveLength(0)
  })
})
