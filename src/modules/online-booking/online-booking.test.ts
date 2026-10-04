import { asc, eq } from 'drizzle-orm'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createJob, createShop, resetDb, type Shop, TUESDAY } from '../../../test/helpers.ts'
import { createApp } from '../../app.ts'
import { db } from '../../db/client.ts'
import {
  arrivalWindows,
  auditEvents,
  callbackRequests,
  consentEvents,
  customers,
  jobItems,
  jobs,
  messages,
  properties,
  serviceAreaZips,
  services,
  tenants,
  waitlistEntries,
} from '../../db/schema.ts'
import { weekdayOf } from '../../lib/labels.ts'
import { emitToTenant } from '../../realtime/index.ts'
import { CONSENT_WORDING, expireHolds, WAITLIST_CONSENT_WORDING } from './online-booking.service.ts'

vi.mock('../../realtime/index.ts', () => ({ emitToTenant: vi.fn() }))

const app = createApp()

beforeEach(async () => {
  await resetDb()
  vi.mocked(emitToTenant).mockClear()
})

// The booking page has no sign-in: the contractor comes from the web address.
function get(path: string, slug = 'desert') {
  return request(app).get(`/api/online-booking/${path}`).set('X-Tenant-Host', `${slug}.localhost`)
}

function post(path: string, body: Record<string, unknown>, slug = 'desert') {
  return request(app)
    .post(`/api/online-booking/${path}`)
    .set('X-Tenant-Host', `${slug}.localhost`)
    .send(body)
}

// A shop that serves Mesa (85201) and downtown Phoenix (85004).
async function createServingShop(slug = 'desert') {
  const shop = await createShop(slug)
  await db
    .insert(serviceAreaZips)
    .values(['85004', '85201'].map((zip) => ({ tenantId: shop.tenant.id, zip })))
  return shop
}

function setPriorityFee(shop: Shop, priorityFeeCents: number) {
  return db.update(tenants).set({ priorityFeeCents }).where(eq(tenants.id, shop.tenant.id))
}

function bookingBody(shop: Shop, overrides: Record<string, unknown> = {}) {
  return {
    serviceId: shop.service.id,
    date: TUESDAY,
    windowId: shop.tueMorning.id,
    problem: 'No cooling since last night',
    systemType: 'central_ac',
    vulnerableOccupant: false,
    priorityService: false,
    name: 'Sam Reed',
    phone: '(480) 555-0199',
    email: 'Sam@Example.com',
    street: '4 Cactus Rd',
    unit: '',
    city: 'Mesa',
    state: 'az',
    zip: '85201',
    consent: true,
    ...overrides,
  }
}

describe('GET /api/online-booking/options', () => {
  it('lists active services, the priority fee and the consent wording', async () => {
    const shop = await createServingShop()
    await setPriorityFee(shop, 4900)
    await db.insert(services).values({
      tenantId: shop.tenant.id,
      name: 'Old service',
      priceType: 'free',
      priceCents: 0,
      archivedAt: new Date(),
    })
    await createShop('other')

    const res = await get('options').expect(200)
    expect(res.body).toEqual({
      services: [
        {
          id: shop.service.id,
          name: 'AC repair',
          description: null,
          priceType: 'diagnostic',
          priceCents: 8900,
        },
      ],
      priorityFeeCents: 4900,
      consentWording: CONSENT_WORDING,
      waitlistConsentWording: WAITLIST_CONSENT_WORDING,
    })
  })

  it('404s for an unknown contractor', async () => {
    await get('options', 'nope').expect(404)
  })
})

describe('GET /api/online-booking/service-area/:zip', () => {
  it('says whether the contractor serves a ZIP code', async () => {
    await createServingShop()
    await createShop('other')

    expect((await get('service-area/85201').expect(200)).body).toEqual({
      zip: '85201',
      served: true,
    })
    expect((await get('service-area/90210').expect(200)).body).toEqual({
      zip: '90210',
      served: false,
    })
    expect((await get('service-area/85201', 'other').expect(200)).body.served).toBe(false)
  })

  it('refuses anything that isn’t a 5-digit ZIP code', async () => {
    await createServingShop()

    const res = await get('service-area/8520').expect(400)
    expect(res.body.error.details).toEqual({ zip: ['Enter a 5-digit ZIP code'] })
  })
})

describe('GET /api/online-booking/windows', () => {
  // The test shop offers 8–12 and 12–4 on Tuesdays and Wednesdays.
  it('lists the open arrival windows of the next two weeks, soonest first', async () => {
    await createServingShop()

    const { days } = (await get('windows').expect(200)).body
    const dates = days.map((day: { date: string }) => day.date)

    // Two Tuesdays and two Wednesdays, minus today when its windows already started.
    expect([3, 4]).toContain(days.length)
    expect(dates).toEqual([...dates].sort())
    for (const date of dates) expect([2, 3]).toContain(weekdayOf(date))
    expect(days.at(-1).windows.map((window: { label: string }) => window.label)).toEqual([
      '8 AM–12 PM',
      '12 PM–4 PM',
    ])
    expect(days.at(-1).label).toMatch(/^(Tue|Wed), /)
  })

  it('leaves out a window that is full, counting holds', async () => {
    const shop = await createServingShop()
    const before = (await get('windows').expect(200)).body.days.at(-1)
    await createJob(shop, { at: `${before.date} 08:00` })
    await createJob(shop, {
      at: `${before.date} 08:00`,
      status: 'held',
      holdExpiresAt: new Date(Date.now() + 60_000),
      bookedAt: null,
    })

    const after = (await get('windows').expect(200)).body.days.at(-1)
    expect(after.date).toBe(before.date)
    expect(after.windows.map((window: { label: string }) => window.label)).toEqual(['12 PM–4 PM'])
  })
})

describe('POST /api/online-booking/bookings', () => {
  it('books the window and saves the homeowner, their address and their consent', async () => {
    const shop = await createServingShop()

    const res = await post('bookings', bookingBody(shop)).expect(201)

    const [job] = await db.select().from(jobs).where(eq(jobs.id, res.body.jobId))
    expect(job).toMatchObject({
      tenantId: shop.tenant.id,
      status: 'booked',
      source: 'web',
      priority: false,
      priorityFeeCents: 0,
      createdBy: null,
      holdExpiresAt: null, // nothing to pay online, so nothing expires
      problem: 'No cooling since last night',
      windowStartsAt: new Date('2030-01-08T15:00:00Z'),
      windowEndsAt: new Date('2030-01-08T19:00:00Z'),
    })
    expect(job.bookedAt).toBeInstanceOf(Date)
    expect(res.body).toEqual({ jobId: job.id })

    const [customer] = await db.select().from(customers).where(eq(customers.id, job.customerId))
    expect(customer).toMatchObject({
      name: 'Sam Reed',
      phone: '+14805550199',
      email: 'sam@example.com',
      source: 'booking',
    })
    const [property] = await db.select().from(properties).where(eq(properties.id, job.propertyId))
    expect(property).toMatchObject({
      street: '4 Cactus Rd',
      unit: null,
      city: 'Mesa',
      state: 'AZ',
      zip: '85201',
    })

    const consent = await db.select().from(consentEvents)
    expect(consent.map((event) => event.channel).sort()).toEqual(['sms', 'voice'])
    for (const event of consent) {
      expect(event).toMatchObject({
        contact: '+14805550199',
        granted: true,
        source: 'booking_form',
        wording: CONSENT_WORDING,
        jobId: job.id,
      })
    }

    const audit = await db.select().from(auditEvents)
    expect(audit).toEqual([
      expect.objectContaining({
        actorType: 'homeowner',
        actorUserId: null,
        action: 'job.booked',
        entityId: job.id,
      }),
    ])
    expect(emitToTenant).toHaveBeenCalledWith(shop.tenant.id, 'booking.created', {
      jobId: job.id,
      dates: [TUESDAY],
    })
  })

  it('records no consent when the box isn’t ticked', async () => {
    const shop = await createServingShop()

    await post('bookings', bookingBody(shop, { consent: false })).expect(201)
    expect(await db.select().from(consentEvents)).toHaveLength(0)
  })

  it('adds the contractor’s priority fee when the homeowner chooses priority service', async () => {
    const shop = await createServingShop()
    await setPriorityFee(shop, 4900)

    const res = await post('bookings', bookingBody(shop, { priorityService: true })).expect(201)
    const [job] = await db.select().from(jobs).where(eq(jobs.id, res.body.jobId))
    expect(job).toMatchObject({ priority: true, priorityFeeCents: 4900, vulnerableOccupant: false })
  })

  it('writes the booked lines: the service, and priority service when chosen', async () => {
    const shop = await createServingShop()
    await setPriorityFee(shop, 4900)

    const res = await post('bookings', bookingBody(shop, { priorityService: true })).expect(201)

    const lines = await db
      .select({
        description: jobItems.description,
        unitPriceCents: jobItems.unitPriceCents,
        status: jobItems.status,
      })
      .from(jobItems)
      .where(eq(jobItems.jobId, res.body.jobId))
      .orderBy(jobItems.description)
    expect(lines).toEqual([
      { description: 'AC repair (diagnostic fee)', unitPriceCents: 8900, status: 'approved' },
      { description: 'Priority service', unitPriceCents: 4900, status: 'approved' },
    ])
  })

  it('ignores a priority request when the contractor doesn’t offer priority service', async () => {
    const shop = await createServingShop()

    const res = await post('bookings', bookingBody(shop, { priorityService: true })).expect(201)
    const [job] = await db.select().from(jobs).where(eq(jobs.id, res.body.jobId))
    expect(job).toMatchObject({ priority: false, priorityFeeCents: 0 })
  })

  it('flags a vulnerable occupant as PRIORITY without charging the fee', async () => {
    const shop = await createServingShop()
    await setPriorityFee(shop, 4900)

    const res = await post('bookings', bookingBody(shop, { vulnerableOccupant: true })).expect(201)
    const [job] = await db.select().from(jobs).where(eq(jobs.id, res.body.jobId))
    expect(job).toMatchObject({ priority: true, priorityFeeCents: 0, vulnerableOccupant: true })
  })

  it('reuses a customer with the same phone and name, and their saved address', async () => {
    const shop = await createServingShop()

    const res = await post(
      'bookings',
      bookingBody(shop, {
        name: 'maria  LOPEZ', // case and spacing don't matter
        phone: '602-555-0111',
        street: '12 palm st',
        city: 'Phoenix',
        zip: '85004',
      }),
    ).expect(201)

    const [job] = await db.select().from(jobs).where(eq(jobs.id, res.body.jobId))
    expect(job).toMatchObject({ customerId: shop.customer.id, propertyId: shop.property.id })
    expect(await db.select().from(customers)).toHaveLength(1)
    expect(await db.select().from(properties)).toHaveLength(1)
  })

  it('keeps someone else on a shared phone as their own customer', async () => {
    const shop = await createServingShop()

    const res = await post(
      'bookings',
      bookingBody(shop, { name: 'John Lopez', phone: '602-555-0111' }),
    ).expect(201)

    const [job] = await db.select().from(jobs).where(eq(jobs.id, res.body.jobId))
    expect(job.customerId).not.toBe(shop.customer.id)
    const [booker] = await db.select().from(customers).where(eq(customers.id, job.customerId))
    expect(booker).toMatchObject({ name: 'John Lopez', phone: '+16025550111' })
    // Maria keeps her name and her earlier jobs.
    const [maria] = await db.select().from(customers).where(eq(customers.id, shop.customer.id))
    expect(maria.name).toBe('Maria Lopez')
  })

  it('refuses a ZIP code outside the service area', async () => {
    const shop = await createServingShop()

    const res = await post('bookings', bookingBody(shop, { zip: '90210' })).expect(422)
    expect(res.body.error).toEqual({
      code: 'outside_area',
      message: 'We don’t serve ZIP code 90210 yet.',
    })
    expect(await db.select().from(jobs)).toHaveLength(0)
  })

  it('never goes over the window’s cap, and doesn’t say how many jobs are booked', async () => {
    const shop = await createServingShop()
    await post('bookings', bookingBody(shop)).expect(201)
    await post('bookings', bookingBody(shop, { phone: '4805550123' })).expect(201)

    const res = await post('bookings', bookingBody(shop, { phone: '4805550124' })).expect(409)
    expect(res.body.error).toEqual({
      code: 'window_full',
      message: 'That arrival window just filled up. Pick another one.',
    })
    // The refused booking saved no confirmation: only the two booked ones have theirs.
    expect(await db.select().from(messages)).toHaveLength(4)
  })

  it('texts and emails the homeowner a confirmation', async () => {
    const shop = await createServingShop()

    const res = await post('bookings', bookingBody(shop)).expect(201)

    // 'email' sorts before 'sms'.
    const sent = await db.select().from(messages).orderBy(asc(messages.channel))
    expect(sent).toEqual([
      expect.objectContaining({
        channel: 'email',
        kind: 'booking_confirmation',
        status: 'queued',
        contact: 'sam@example.com',
        subject: 'Your visit is booked: Tue, Jan 8',
        jobId: res.body.jobId,
      }),
      expect.objectContaining({
        channel: 'sms',
        kind: 'booking_confirmation',
        status: 'queued',
        contact: '+14805550199',
        body: "desert HVAC: you're booked for AC repair on Tue, Jan 8, 8 AM - 12 PM at 4 Cactus Rd. Pay at the visit. Reply STOP to opt out.",
        jobId: res.body.jobId,
      }),
    ])
    expect(sent[0].customerId).toBe(sent[1].customerId)
    expect(sent[0].body).toContain('Address: 4 Cactus Rd, Mesa, AZ 85201')
    expect(sent[0].body).toContain('Questions? Call (480) 555-0100 or reply to this email.')
  })

  it('keeps the text from someone who didn’t agree to texts, and skips a blank email', async () => {
    const shop = await createServingShop()

    await post('bookings', bookingBody(shop, { consent: false, email: '' })).expect(201)

    expect(await db.select().from(messages)).toEqual([
      expect.objectContaining({
        channel: 'sms',
        kind: 'booking_confirmation',
        status: 'blocked',
        blockedReason: 'no_consent',
      }),
    ])
  })

  it('refuses a date in the past', async () => {
    const shop = await createServingShop()

    const res = await post('bookings', bookingBody(shop, { date: '2020-01-07' })).expect(422)
    expect(res.body.error.message).toBe('Pick today or a later date.')
  })

  it('refuses, and doesn’t list, a window that already started today', async () => {
    const shop = await createServingShop()
    // A window that opened at midnight today, Phoenix time.
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Phoenix' }).format(
      new Date(),
    )
    const [midnight] = await db
      .insert(arrivalWindows)
      .values({
        tenantId: shop.tenant.id,
        weekday: weekdayOf(today),
        startsAt: '00:00',
        endsAt: '00:01',
        jobCap: 2,
      })
      .returning()

    const res = await post('bookings', bookingBody(shop, { date: today, windowId: midnight.id }))
    expect(res.status).toBe(422)
    expect(res.body.error).toEqual({
      code: 'window_started',
      message: 'That arrival window has already started. Pick a later one.',
    })

    const { days } = (await get('windows').expect(200)).body
    const listed = days.flatMap((day: { date: string; windows: { id: string }[] }) =>
      day.date === today ? day.windows.map((window) => window.id) : [],
    )
    expect(listed).not.toContain(midnight.id)
  })

  it('never uses another contractor’s service or window', async () => {
    const shop = await createServingShop()
    const other = await createServingShop('other')

    const service = await post('bookings', bookingBody(shop, { serviceId: other.service.id }))
    expect(service.status).toBe(404)
    expect(service.body.error.message).toBe('That service isn’t offered anymore. Pick another one.')
    const window = await post('bookings', bookingBody(shop, { windowId: other.tueMorning.id }))
    expect(window.status).toBe(404)
    await post('bookings', bookingBody(shop), 'nope').expect(404)
  })

  it('lists every missing piece of an empty form at once', async () => {
    await createServingShop()

    const res = await post('bookings', {}).expect(400)
    expect(Object.keys(res.body.error.details).sort()).toEqual([
      'city',
      'date',
      'name',
      'phone',
      'problem',
      'serviceId',
      'state',
      'street',
      'systemType',
      'windowId',
      'zip',
    ])
    expect(res.body.error.details.name).toEqual(['Enter your name'])
  })
})

describe('POST /api/online-booking/waitlist', () => {
  function waitlistBody(shop: Shop, overrides: Record<string, unknown> = {}) {
    return {
      serviceId: shop.service.id,
      zip: '85201',
      name: 'Sam Reed',
      phone: '(480) 555-0199',
      vulnerableOccupant: true,
      consent: true,
      ...overrides,
    }
  }

  it('adds the homeowner to the waitlist with their consent to a text', async () => {
    const shop = await createServingShop()

    await post('waitlist', waitlistBody(shop)).expect(201)

    const [customer] = await db.select().from(customers).where(eq(customers.phone, '+14805550199'))
    expect(customer).toMatchObject({ name: 'Sam Reed', source: 'booking' })
    expect(await db.select().from(waitlistEntries)).toEqual([
      expect.objectContaining({
        customerId: customer.id,
        serviceId: shop.service.id,
        zip: '85201',
        priority: true,
        status: 'waiting',
      }),
    ])
    expect(await db.select().from(consentEvents)).toEqual([
      expect.objectContaining({
        contact: '+14805550199',
        channel: 'sms',
        granted: true,
        source: 'booking_form',
        wording: WAITLIST_CONSENT_WORDING,
      }),
    ])
  })

  it('needs the consent box, because the waitlist answers by text', async () => {
    const shop = await createServingShop()

    const res = await post('waitlist', waitlistBody(shop, { consent: false })).expect(400)
    expect(res.body.error.details).toEqual({
      consent: ['Tick the box so we can text you when a time opens'],
    })
    expect(await db.select().from(waitlistEntries)).toHaveLength(0)
  })

  it('refuses a ZIP code outside the service area', async () => {
    const shop = await createServingShop()

    await post('waitlist', waitlistBody(shop, { zip: '90210' })).expect(422)
  })
})

describe('POST /api/online-booking/callbacks', () => {
  it('saves a callback request for the office', async () => {
    const shop = await createServingShop()

    await post('callbacks', { name: 'Pat Lee', phone: '310-555-0188', zip: '90210' }).expect(201)
    await post('callbacks', {
      name: 'Kim Wu',
      phone: '310-555-0189',
      zip: '90211',
      message: 'Call after 5 PM',
    }).expect(201)

    const requests = await db.select().from(callbackRequests).orderBy(callbackRequests.zip)
    expect(requests).toEqual([
      expect.objectContaining({
        tenantId: shop.tenant.id,
        name: 'Pat Lee',
        phone: '+13105550188',
        zip: '90210',
        message: 'Asked for a callback. ZIP code 90210 is outside the service area.',
        source: 'web',
        resolvedAt: null,
      }),
      expect.objectContaining({ name: 'Kim Wu', message: 'Call after 5 PM' }),
    ])
  })

  it('explains bad input field by field', async () => {
    await createServingShop()

    const res = await post('callbacks', { name: '', phone: '555', zip: '9021' }).expect(400)
    expect(res.body.error.details).toEqual({
      name: ['Enter your name'],
      phone: ['Enter a mobile number, like 0917 123 4567'],
      zip: ['Enter a 5-digit ZIP code'],
    })
  })
})

describe('expireHolds', () => {
  it('expires holds that ran out of time and frees their place in the window', async () => {
    const shop = await createServingShop()
    const held = { status: 'held', bookedAt: null } as const
    const stale = await createJob(shop, { ...held, holdExpiresAt: new Date(Date.now() - 1000) })
    const fresh = await createJob(shop, { ...held, holdExpiresAt: new Date(Date.now() + 60_000) })
    await post('bookings', bookingBody(shop)).expect(409) // both places taken

    expect(await expireHolds()).toBe(1)

    const statusOf = async (jobId: string) =>
      (await db.select().from(jobs).where(eq(jobs.id, jobId)))[0].status
    expect(await statusOf(stale.id)).toBe('expired')
    expect(await statusOf(fresh.id)).toBe('held')
    await post('bookings', bookingBody(shop)).expect(201)
  })
})
