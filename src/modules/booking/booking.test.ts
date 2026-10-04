import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createJob,
  createShop,
  createUser,
  resetDb,
  type Shop,
  signIn,
  TUESDAY,
  WEDNESDAY,
} from '../../../test/helpers.ts'
import { createApp } from '../../app.ts'
import { db } from '../../db/client.ts'
import {
  auditEvents,
  consentEvents,
  customers,
  jobItems,
  jobs,
  properties,
  services,
} from '../../db/schema.ts'
import { emitToTenant } from '../../realtime/index.ts'

vi.mock('../../realtime/index.ts', () => ({ emitToTenant: vi.fn() }))

const app = createApp()

beforeEach(async () => {
  await resetDb()
  vi.mocked(emitToTenant).mockClear()
})

function book(shop: Shop, body: Record<string, unknown>) {
  return request(app).post('/api/bookings').set('Cookie', shop.cookie).send(body)
}

function newCustomerBooking(shop: Shop, overrides: Record<string, unknown> = {}) {
  return {
    newCustomer: { name: 'Sam Reed', phone: '(480) 555-0199', email: 'Sam@Example.com' },
    newProperty: { street: '4 Cactus Rd', city: 'Mesa', state: 'az', zip: '85201' },
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

describe('GET /api/services', () => {
  it("lists the contractor's active services", async () => {
    const shop = await createShop('desert')
    await db.insert(services).values({
      tenantId: shop.tenant.id,
      name: 'Old service',
      priceType: 'free',
      priceCents: 0,
      archivedAt: new Date(),
    })
    const other = await createShop('other')

    const res = await request(app).get('/api/services').set('Cookie', shop.cookie).expect(200)
    expect(res.body.services).toEqual([
      { id: shop.service.id, name: 'AC repair', priceType: 'diagnostic', priceCents: 8900 },
    ])
    expect(JSON.stringify(res.body)).not.toContain(other.service.id)
  })
})

describe('POST /api/bookings', () => {
  it('writes the booked service line at the price it was booked at', async () => {
    const shop = await createShop('desert')

    const res = await book(shop, newCustomerBooking(shop)).expect(201)
    // A later price change doesn't touch the job.
    await db.update(services).set({ priceCents: 9900 }).where(eq(services.id, shop.service.id))

    const lines = await db.select().from(jobItems).where(eq(jobItems.jobId, res.body.jobId))
    expect(lines).toEqual([
      expect.objectContaining({
        description: 'AC repair (diagnostic fee)',
        quantity: 1,
        unitPriceCents: 8900,
        status: 'approved',
        priceItemId: null,
      }),
    ])
  })

  it('writes a free service line at $0', async () => {
    const shop = await createShop('desert')
    const [estimate] = await db
      .insert(services)
      .values({
        tenantId: shop.tenant.id,
        name: 'New-system estimate',
        priceType: 'free',
        priceCents: 0,
      })
      .returning()

    const res = await book(shop, newCustomerBooking(shop, { serviceId: estimate.id })).expect(201)

    const lines = await db.select().from(jobItems).where(eq(jobItems.jobId, res.body.jobId))
    expect(lines).toEqual([
      expect.objectContaining({ description: 'New-system estimate (free)', unitPriceCents: 0 }),
    ])
  })

  it('books a new customer into a window and records consent', async () => {
    const shop = await createShop('desert')

    const res = await book(shop, newCustomerBooking(shop)).expect(201)

    const [job] = await db.select().from(jobs).where(eq(jobs.id, res.body.jobId))
    expect(job).toMatchObject({
      tenantId: shop.tenant.id,
      status: 'booked',
      source: 'office',
      priority: false,
      technicianId: null,
      createdBy: shop.office.id,
      problem: 'No cooling since last night',
      windowStartsAt: new Date('2030-01-08T15:00:00Z'),
      windowEndsAt: new Date('2030-01-08T19:00:00Z'),
    })
    expect(job.bookedAt).toBeInstanceOf(Date)
    expect(res.body).toEqual({ jobId: job.id, date: TUESDAY })

    const [customer] = await db.select().from(customers).where(eq(customers.id, job.customerId))
    expect(customer).toMatchObject({
      name: 'Sam Reed',
      phone: '+14805550199',
      email: 'sam@example.com',
      source: 'office',
    })
    const [property] = await db.select().from(properties).where(eq(properties.id, job.propertyId))
    expect(property).toMatchObject({ street: '4 Cactus Rd', state: 'AZ', zip: '85201' })

    const consent = await db.select().from(consentEvents)
    expect(consent).toEqual([
      expect.objectContaining({
        contact: '+14805550199',
        channel: 'sms',
        granted: true,
        source: 'office',
        createdBy: shop.office.id,
      }),
    ])
    expect(consent[0].wording).toMatch(/texts/)

    const audit = await db.select().from(auditEvents)
    expect(audit.map((event) => event.action).sort()).toEqual(['consent.recorded', 'job.booked'])

    expect(emitToTenant).toHaveBeenCalledWith(shop.tenant.id, 'booking.created', {
      jobId: job.id,
      dates: [TUESDAY],
    })
    expect(emitToTenant).not.toHaveBeenCalledWith(
      shop.tenant.id,
      'booking.priority',
      expect.anything(),
    )
  })

  it('books an existing customer at an existing address and flags a vulnerable occupant', async () => {
    const shop = await createShop('desert')

    const res = await book(shop, {
      customerId: shop.customer.id,
      propertyId: shop.property.id,
      serviceId: shop.service.id,
      date: TUESDAY,
      windowId: shop.tueAfternoon.id,
      problem: 'No heat, baby at home',
      systemType: 'furnace',
      vulnerableOccupant: true,
      consentToTexts: false,
    }).expect(201)

    const [job] = await db.select().from(jobs).where(eq(jobs.id, res.body.jobId))
    expect(job).toMatchObject({
      customerId: shop.customer.id,
      propertyId: shop.property.id,
      priority: true,
      vulnerableOccupant: true,
      windowStartsAt: new Date('2030-01-08T19:00:00Z'),
    })
    expect(await db.select().from(customers)).toHaveLength(1)
    expect(await db.select().from(consentEvents)).toHaveLength(0)
    expect(emitToTenant).toHaveBeenCalledWith(shop.tenant.id, 'booking.priority', {
      jobId: job.id,
      dates: [TUESDAY],
    })
  })

  it('refuses a full window with a readable message, unless the office overrides it', async () => {
    const shop = await createShop('desert')
    await createJob(shop)
    await createJob(shop)

    const full = await book(shop, newCustomerBooking(shop)).expect(409)
    expect(full.body.error).toEqual({
      code: 'window_full',
      message: 'The 8 AM–12 PM window on Tue, Jan 8 is full (2 of 2 booked).',
    })

    await book(shop, newCustomerBooking(shop, { allowOverCap: true })).expect(201)
  })

  it('does not count cancelled jobs against the cap', async () => {
    const shop = await createShop('desert')
    await createJob(shop, { status: 'cancelled' })
    await createJob(shop)

    await book(shop, newCustomerBooking(shop)).expect(201)
  })

  it('gives the last slot to only one of two bookings made at the same moment', async () => {
    const shop = await createShop('desert')
    await createJob(shop)

    const results = await Promise.all([
      book(shop, newCustomerBooking(shop)),
      book(shop, newCustomerBooking(shop, { newCustomer: { name: 'Lee', phone: '4805550123' } })),
    ])
    expect(results.map((res) => res.status).sort()).toEqual([201, 409])
  })

  it("rejects a window that isn't offered on that day", async () => {
    const shop = await createShop('desert')

    const res = await book(shop, newCustomerBooking(shop, { date: WEDNESDAY })).expect(422)
    expect(res.body.error).toEqual({
      code: 'window_not_offered',
      message: 'The 8 AM–12 PM window isn’t offered on Wednesdays. Pick another window.',
    })
  })

  it('rejects a date in the past', async () => {
    const shop = await createShop('desert')

    const res = await book(shop, newCustomerBooking(shop, { date: '2020-01-07' })).expect(422)
    expect(res.body.error.message).toBe('Pick today or a later date.')
  })

  it("never uses another contractor's window, customer or address", async () => {
    const shop = await createShop('desert')
    const other = await createShop('other')

    const window = await book(shop, newCustomerBooking(shop, { windowId: other.tueMorning.id }))
    expect(window.status).toBe(404)
    expect(window.body.error.message).toBe(
      'That arrival window doesn’t exist anymore. Pick another one.',
    )

    const customer = await book(shop, {
      ...newCustomerBooking(shop),
      newCustomer: undefined,
      customerId: other.customer.id,
    })
    expect(customer.status).toBe(404)
    expect(customer.body.error.message).toBe('That customer wasn’t found. Search again.')

    const property = await book(shop, {
      ...newCustomerBooking(shop),
      newCustomer: undefined,
      newProperty: undefined,
      customerId: shop.customer.id,
      propertyId: other.property.id,
    })
    expect(property.status).toBe(404)
    expect(property.body.error.message).toBe('That address wasn’t found for this customer.')
  })

  it('explains bad input field by field', async () => {
    const shop = await createShop('desert')

    const res = await book(
      shop,
      newCustomerBooking(shop, {
        newCustomer: { name: '', phone: '555' },
        newProperty: { street: '4 Cactus Rd', city: 'Mesa', state: 'Arizona', zip: '852' },
        problem: '',
      }),
    ).expect(400)
    expect(res.body.error.message).toBe('Check the highlighted fields.')
    expect(res.body.error.details).toEqual({
      'newCustomer.name': ['Enter the customer’s name'],
      'newCustomer.phone': ['Enter a mobile number, like 0917 123 4567'],
      'newProperty.state': ['Enter a 2-letter state, like AZ'],
      'newProperty.zip': ['Enter a 5-digit ZIP code'],
      problem: ['Describe the problem'],
    })
  })

  it('lists every missing piece of an empty form at once', async () => {
    const shop = await createShop('desert')

    const res = await book(shop, {}).expect(400)
    expect(Object.keys(res.body.error.details).sort()).toEqual([
      'customerId',
      'date',
      'problem',
      'propertyId',
      'serviceId',
      'systemType',
      'windowId',
    ])
    expect(res.body.error.details.customerId).toEqual(['Pick a customer or add a new one'])
  })

  it('needs a customer and an address', async () => {
    const shop = await createShop('desert')

    const res = await book(shop, {
      ...newCustomerBooking(shop),
      newCustomer: undefined,
      newProperty: undefined,
    }).expect(400)
    expect(res.body.error.details).toEqual({
      customerId: ['Pick a customer or add a new one'],
      propertyId: ['Pick an address or add a new one'],
    })
  })

  it('is for owner and office staff only', async () => {
    const shop = await createShop('desert')
    const owner = await createUser('owner', shop.tenant.id)
    const admin = await createUser('superadmin', null)
    const body = newCustomerBooking(shop)

    await request(app).post('/api/bookings').send(body).expect(401)
    await request(app)
      .post('/api/bookings')
      .set('Cookie', await signIn(admin.email))
      .send(body)
      .expect(403)
    await request(app)
      .post('/api/bookings')
      .set('Cookie', await signIn(owner.email))
      .send(body)
      .expect(201)
  })

  it('404s for an unknown service', async () => {
    const shop = await createShop('desert')
    const res = await book(shop, newCustomerBooking(shop, { serviceId: randomUUID() })).expect(404)
    expect(res.body.error.message).toBe('That service isn’t offered anymore. Pick another one.')
  })
})
