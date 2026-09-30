import { randomUUID } from 'node:crypto'
import { asc, eq } from 'drizzle-orm'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createShop,
  createUser,
  resetDb,
  type Shop,
  signIn,
  TUESDAY,
} from '../../../test/helpers.ts'
import { createApp } from '../../app.ts'
import { db } from '../../db/client.ts'
import { auditEvents, services } from '../../db/schema.ts'
import { emitToTenant } from '../../realtime/index.ts'

vi.mock('../../realtime/index.ts', () => ({ emitToTenant: vi.fn() }))

const app = createApp()

// The service every test shop starts with.
const AC_REPAIR = {
  name: 'AC repair',
  description: null,
  priceType: 'diagnostic',
  priceCents: 8900,
  archived: false,
}
const TUNE_UP = { name: 'Tune-up', priceType: 'fixed', priceCents: 12900 }

beforeEach(async () => {
  await resetDb()
  vi.mocked(emitToTenant).mockClear()
})

function addService(shop: Shop, body: Record<string, unknown>) {
  return request(app).post('/api/services').set('Cookie', shop.cookie).send(body)
}

function listAll(shop: Shop) {
  return request(app).get('/api/services/all').set('Cookie', shop.cookie).expect(200)
}

// What the booking form offers.
async function bookableNames(shop: Shop) {
  const res = await request(app).get('/api/services').set('Cookie', shop.cookie).expect(200)
  return res.body.services.map((service: { name: string }) => service.name)
}

function expectServicesUpdated(shop: Shop) {
  expect(emitToTenant).toHaveBeenCalledWith(shop.tenant.id, 'services.updated', {
    tenantId: shop.tenant.id,
  })
}

describe('GET /api/services/all', () => {
  it("lists the contractor's services in their order, archived ones last", async () => {
    const shop = await createShop('desert')
    await db.insert(services).values([
      {
        tenantId: shop.tenant.id,
        name: 'Old service',
        priceType: 'free',
        priceCents: 0,
        sortOrder: 1,
        archivedAt: new Date(),
      },
      {
        tenantId: shop.tenant.id,
        name: 'Tune-up',
        description: 'Seasonal check of the whole system',
        priceType: 'fixed',
        priceCents: 12900,
        sortOrder: 2,
      },
    ])
    const other = await createShop('other')

    const res = await listAll(shop)

    expect(res.body.services).toEqual([
      { id: shop.service.id, ...AC_REPAIR },
      {
        id: expect.any(String),
        name: 'Tune-up',
        description: 'Seasonal check of the whole system',
        priceType: 'fixed',
        priceCents: 12900,
        archived: false,
      },
      {
        id: expect.any(String),
        name: 'Old service',
        description: null,
        priceType: 'free',
        priceCents: 0,
        archived: true,
      },
    ])
    expect(JSON.stringify(res.body)).not.toContain(other.service.id)
  })

  it('is for owner and office staff only', async () => {
    const shop = await createShop('desert')
    const owner = await createUser('owner', shop.tenant.id)
    const tech = await createUser('technician', shop.tenant.id)
    const admin = await createUser('superadmin', null)

    await request(app).get('/api/services/all').expect(401)
    await request(app).post('/api/services').send(TUNE_UP).expect(401)
    for (const email of [tech.email, admin.email]) {
      const cookie = await signIn(email)
      await request(app).get('/api/services/all').set('Cookie', cookie).expect(403)
      await request(app).post('/api/services').set('Cookie', cookie).send(TUNE_UP).expect(403)
    }
    await request(app)
      .get('/api/services/all')
      .set('Cookie', await signIn(owner.email))
      .expect(200)
  })
})

describe('POST /api/services', () => {
  it('adds a service at the end of the list and tells open dashboards', async () => {
    const shop = await createShop('desert')

    const res = await addService(shop, {
      name: '  Tune-up ',
      description: ' Seasonal check of the whole system ',
      priceType: 'fixed',
      priceCents: 12900,
    }).expect(201)

    expect(res.body.service).toEqual({
      id: expect.any(String),
      name: 'Tune-up',
      description: 'Seasonal check of the whole system',
      priceType: 'fixed',
      priceCents: 12900,
      archived: false,
    })
    const [saved] = await db.select().from(services).where(eq(services.id, res.body.service.id))
    expect(saved).toMatchObject({ tenantId: shop.tenant.id, sortOrder: 1, archivedAt: null })
    expect(await bookableNames(shop)).toEqual(['AC repair', 'Tune-up'])

    const [audit] = await db.select().from(auditEvents)
    expect(audit).toMatchObject({
      action: 'service.created',
      entityType: 'service',
      entityId: saved.id,
      actorUserId: shop.office.id,
    })
    expectServicesUpdated(shop)
  })

  it('explains bad input field by field', async () => {
    const shop = await createShop('desert')

    const res = await addService(shop, {
      name: ' ',
      description: 'x'.repeat(501),
      priceType: 'hourly',
      priceCents: 12.5,
    }).expect(400)

    expect(res.body.error.details).toEqual({
      name: ['Enter the service name'],
      description: ['Keep the description to 500 characters or fewer'],
      priceType: ['Pick how this service is priced'],
      priceCents: ['Enter a price in dollars and cents'],
    })
  })

  it('needs a name, a price type and a price', async () => {
    const shop = await createShop('desert')
    const res = await addService(shop, {}).expect(400)
    expect(Object.keys(res.body.error.details).sort()).toEqual(['name', 'priceCents', 'priceType'])
  })

  it('keeps the name to 100 characters', async () => {
    const shop = await createShop('desert')
    const res = await addService(shop, { ...TUNE_UP, name: 'x'.repeat(101) }).expect(400)
    expect(res.body.error.details).toEqual({
      name: ['Keep the name to 100 characters or fewer'],
    })
  })

  it('treats a blank description as none', async () => {
    const shop = await createShop('desert')
    const res = await addService(shop, { ...TUNE_UP, description: '  ' }).expect(201)
    expect(res.body.service.description).toBeNull()
  })

  it('takes a free service only at no price', async () => {
    const shop = await createShop('desert')

    const priced = await addService(shop, {
      name: 'New-system estimate',
      priceType: 'free',
      priceCents: 100,
    }).expect(400)
    expect(priced.body.error.details).toEqual({
      priceCents: ['A free service can’t have a price'],
    })

    const free = await addService(shop, {
      name: 'New-system estimate',
      priceType: 'free',
      priceCents: 0,
    }).expect(201)
    expect(free.body.service).toMatchObject({ priceType: 'free', priceCents: 0 })
  })

  it('needs a price above $0, up to $100,000, unless the service is free', async () => {
    const shop = await createShop('desert')

    for (const priceType of ['fixed', 'diagnostic']) {
      for (const priceCents of [0, -500]) {
        const res = await addService(shop, { name: 'Tune-up', priceType, priceCents }).expect(400)
        expect(res.body.error.details).toEqual({ priceCents: ['Enter a price above $0'] })
      }
    }
    const tooMuch = await addService(shop, { ...TUNE_UP, priceCents: 10_000_001 }).expect(400)
    expect(tooMuch.body.error.details).toEqual({
      priceCents: ['Enter a price of $100,000 or less'],
    })
    await addService(shop, { ...TUNE_UP, priceCents: 10_000_000 }).expect(201)
  })
})

describe('PATCH /api/services/:serviceId', () => {
  it('updates the name, description and price', async () => {
    const shop = await createShop('desert')

    const res = await request(app)
      .patch(`/api/services/${shop.service.id}`)
      .set('Cookie', shop.cookie)
      .send({
        name: 'AC repair visit',
        description: 'We find the problem and quote the repair',
        priceType: 'fixed',
        priceCents: 9900,
      })
      .expect(200)

    expect(res.body.service).toEqual({
      id: shop.service.id,
      name: 'AC repair visit',
      description: 'We find the problem and quote the repair',
      priceType: 'fixed',
      priceCents: 9900,
      archived: false,
    })
    const [saved] = await db.select().from(services).where(eq(services.id, shop.service.id))
    expect(saved).toMatchObject({ name: 'AC repair visit', priceCents: 9900, sortOrder: 0 })

    const [audit] = await db.select().from(auditEvents)
    expect(audit).toMatchObject({ action: 'service.updated', entityId: shop.service.id })
    expectServicesUpdated(shop)
  })

  it('checks the input like adding does', async () => {
    const shop = await createShop('desert')
    const res = await request(app)
      .patch(`/api/services/${shop.service.id}`)
      .set('Cookie', shop.cookie)
      .send({ name: 'AC repair', priceType: 'free', priceCents: 8900 })
      .expect(400)
    expect(res.body.error.details).toEqual({
      priceCents: ['A free service can’t have a price'],
    })
  })

  it("only edits this contractor's services", async () => {
    const shop = await createShop('desert')
    const other = await createShop('other')

    for (const id of [other.service.id, randomUUID()]) {
      const res = await request(app)
        .patch(`/api/services/${id}`)
        .set('Cookie', shop.cookie)
        .send({ ...TUNE_UP, name: 'Hijacked' })
        .expect(404)
      expect(res.body.error.message).toBe('That service isn’t on your list.')
    }
    const [untouched] = await db.select().from(services).where(eq(services.id, other.service.id))
    expect(untouched.name).toBe('AC repair')
  })
})

describe('POST /api/services/:serviceId/archive', () => {
  it('takes the service off booking but keeps it on the list', async () => {
    const shop = await createShop('desert')

    const res = await request(app)
      .post(`/api/services/${shop.service.id}/archive`)
      .set('Cookie', shop.cookie)
      .expect(200)

    expect(res.body.service).toEqual({ id: shop.service.id, ...AC_REPAIR, archived: true })
    expect(await bookableNames(shop)).toEqual([])
    expect((await listAll(shop)).body.services).toEqual([
      { id: shop.service.id, ...AC_REPAIR, archived: true },
    ])

    const booking = await request(app)
      .post('/api/bookings')
      .set('Cookie', shop.cookie)
      .send({
        customerId: shop.customer.id,
        propertyId: shop.property.id,
        serviceId: shop.service.id,
        date: TUESDAY,
        windowId: shop.tueMorning.id,
        problem: 'No cooling',
        systemType: 'central_ac',
        vulnerableOccupant: false,
        consentToTexts: false,
      })
      .expect(404)
    expect(booking.body.error.message).toBe('That service isn’t offered anymore. Pick another one.')

    const [audit] = await db.select().from(auditEvents)
    expect(audit).toMatchObject({ action: 'service.archived', entityId: shop.service.id })
    expectServicesUpdated(shop)
  })

  it('does nothing more the second time', async () => {
    const shop = await createShop('desert')
    const url = `/api/services/${shop.service.id}/archive`
    await request(app).post(url).set('Cookie', shop.cookie).expect(200)
    const [first] = await db.select().from(services).where(eq(services.id, shop.service.id))

    const again = await request(app).post(url).set('Cookie', shop.cookie).expect(200)

    expect(again.body.service.archived).toBe(true)
    const [second] = await db.select().from(services).where(eq(services.id, shop.service.id))
    expect(second.archivedAt).toEqual(first.archivedAt)
    expect(await db.select().from(auditEvents)).toHaveLength(1)
  })

  it("404s for another contractor's service", async () => {
    const shop = await createShop('desert')
    const other = await createShop('other')
    await request(app)
      .post(`/api/services/${other.service.id}/archive`)
      .set('Cookie', shop.cookie)
      .expect(404)
    const [untouched] = await db.select().from(services).where(eq(services.id, other.service.id))
    expect(untouched.archivedAt).toBeNull()
  })
})

describe('POST /api/services/:serviceId/restore', () => {
  it('puts an archived service back on booking, at the end of the list', async () => {
    const shop = await createShop('desert')
    const tuneUp = (await addService(shop, TUNE_UP).expect(201)).body.service
    await request(app)
      .post(`/api/services/${shop.service.id}/archive`)
      .set('Cookie', shop.cookie)
      .expect(200)
    vi.mocked(emitToTenant).mockClear()

    const res = await request(app)
      .post(`/api/services/${shop.service.id}/restore`)
      .set('Cookie', shop.cookie)
      .expect(200)

    expect(res.body.service).toEqual({ id: shop.service.id, ...AC_REPAIR })
    expect(await bookableNames(shop)).toEqual([tuneUp.name, 'AC repair'])
    const audits = await db.select().from(auditEvents).orderBy(asc(auditEvents.createdAt))
    expect(audits.at(-1)).toMatchObject({ action: 'service.restored', entityId: shop.service.id })
    expectServicesUpdated(shop)
  })

  it('leaves a service that isn’t archived where it is', async () => {
    const shop = await createShop('desert')
    await addService(shop, TUNE_UP).expect(201)

    const res = await request(app)
      .post(`/api/services/${shop.service.id}/restore`)
      .set('Cookie', shop.cookie)
      .expect(200)

    expect(res.body.service.archived).toBe(false)
    expect(await bookableNames(shop)).toEqual(['AC repair', 'Tune-up'])
  })

  it("404s for another contractor's service", async () => {
    const shop = await createShop('desert')
    const other = await createShop('other')
    await request(app)
      .post(`/api/services/${other.service.id}/restore`)
      .set('Cookie', shop.cookie)
      .expect(404)
  })
})

describe('PUT /api/services/order', () => {
  function reorder(shop: Shop, ids: unknown) {
    return request(app).put('/api/services/order').set('Cookie', shop.cookie).send({ ids })
  }

  it('shows services in the new order, on the list and on booking', async () => {
    const shop = await createShop('desert')
    const tuneUp = (await addService(shop, TUNE_UP).expect(201)).body.service
    const estimate = (
      await addService(shop, { name: 'Estimate', priceType: 'free', priceCents: 0 }).expect(201)
    ).body.service
    vi.mocked(emitToTenant).mockClear()

    const res = await reorder(shop, [estimate.id, shop.service.id, tuneUp.id]).expect(200)

    const names = ['Estimate', 'AC repair', 'Tune-up']
    expect(res.body.services.map((service: { name: string }) => service.name)).toEqual(names)
    expect(await bookableNames(shop)).toEqual(names)
    const audits = await db.select().from(auditEvents).orderBy(asc(auditEvents.createdAt))
    expect(audits.at(-1)).toMatchObject({
      action: 'service.reordered',
      entityType: 'service',
      entityId: null,
      data: { ids: [estimate.id, shop.service.id, tuneUp.id] },
    })
    expectServicesUpdated(shop)
  })

  it('refuses an order that doesn’t match the active services', async () => {
    const shop = await createShop('desert')
    const other = await createShop('other')
    const tuneUp = (await addService(shop, TUNE_UP).expect(201)).body.service
    const archived = (await addService(shop, { ...TUNE_UP, name: 'Old' }).expect(201)).body.service
    await request(app)
      .post(`/api/services/${archived.id}/archive`)
      .set('Cookie', shop.cookie)
      .expect(200)

    const wrong = [
      [tuneUp.id], // one missing
      [tuneUp.id, shop.service.id, other.service.id], // another contractor's
      [tuneUp.id, shop.service.id, archived.id], // an archived one
      [tuneUp.id, tuneUp.id], // the same one twice
    ]
    for (const ids of wrong) {
      const res = await reorder(shop, ids).expect(409)
      expect(res.body.error).toEqual({
        code: 'services_changed',
        message: 'Your services changed since this page loaded. Refresh and try again.',
      })
    }
    expect(await bookableNames(shop)).toEqual(['AC repair', 'Tune-up'])
  })

  it('needs a list of service ids', async () => {
    const shop = await createShop('desert')
    await reorder(shop, 'first').expect(400)
    await reorder(shop, ['not-an-id']).expect(400)
  })
})
