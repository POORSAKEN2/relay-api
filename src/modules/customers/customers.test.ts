import { eq } from 'drizzle-orm'
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  createJob,
  createShop,
  resetDb,
  type Shop,
  TUESDAY,
  WEDNESDAY,
} from '../../../test/helpers.ts'
import { createApp } from '../../app.ts'
import { db } from '../../db/client.ts'
import { customers, properties } from '../../db/schema.ts'

const app = createApp()

beforeEach(resetDb)

function getAs(shop: Shop, path: string) {
  return request(app).get(path).set('Cookie', shop.cookie).expect(200)
}

// The names on one page of the list, in order.
const names = (res: request.Response) =>
  res.body.customers.map((customer: { name: string }) => customer.name)

describe('GET /api/customers', () => {
  it('lists everyone by name when nothing is typed, with their addresses', async () => {
    const shop = await createShop('desert')
    await db
      .insert(customers)
      .values({ tenantId: shop.tenant.id, name: 'Zed Young', source: 'office' })

    const res = await getAs(shop, '/api/customers')
    expect(names(res)).toEqual(['Maria Lopez', 'Zed Young'])
    expect(res.body.total).toBe(2)
    expect(res.body.pageSize).toBe(25)
    expect(res.body.customers[0]).toEqual({
      id: shop.customer.id,
      name: 'Maria Lopez',
      phone: '+16025550111',
      email: null,
      properties: [
        {
          id: shop.property.id,
          street: '12 Palm St',
          unit: null,
          city: 'Phoenix',
          state: 'AZ',
          zip: '85004',
          equipmentBrand: null,
          equipmentYear: null,
          notes: null,
        },
      ],
      lastVisitDate: null,
      nextVisitDate: null,
    })
  })

  it('finds customers by name, street, email or phone digits', async () => {
    const shop = await createShop('desert')
    await db.insert(customers).values({
      tenantId: shop.tenant.id,
      name: 'Bob Marley',
      email: 'bob@reggae.test',
      source: 'office',
    })
    const search = (q: string) => getAs(shop, `/api/customers?q=${encodeURIComponent(q)}`)

    expect(names(await search('lopez'))).toEqual(['Maria Lopez'])
    expect(names(await search('palm st'))).toEqual(['Maria Lopez'])
    expect(names(await search('reggae'))).toEqual(['Bob Marley'])
    expect(names(await search('(602) 555-01'))).toEqual(['Maria Lopez'])
    expect(names(await search('zzz'))).toEqual([])
  })

  it('sorts newest first when asked, and falls back to names for anything else', async () => {
    const shop = await createShop('desert')
    await db
      .insert(customers)
      .values({ tenantId: shop.tenant.id, name: 'Zed Young', source: 'office' })

    expect(names(await getAs(shop, '/api/customers?sort=newest'))).toEqual([
      'Zed Young',
      'Maria Lopez',
    ])
    expect(names(await getAs(shop, '/api/customers?sort=bogus&page=0'))).toEqual([
      'Maria Lopez',
      'Zed Young',
    ])
  })

  it('pages 25 at a time and counts every customer', async () => {
    const shop = await createShop('desert')
    await db.insert(customers).values(
      Array.from({ length: 25 }, (_, i) => ({
        tenantId: shop.tenant.id,
        name: `Test ${String(i).padStart(2, '0')}`,
        source: 'office' as const,
      })),
    )

    const first = await getAs(shop, '/api/customers')
    expect(first.body.customers).toHaveLength(25)
    expect(first.body.total).toBe(26)
    expect(names(await getAs(shop, '/api/customers?page=2'))).toEqual(['Test 24'])
  })

  it('shows the next upcoming visit and the last finished one', async () => {
    const shop = await createShop('desert')
    await createJob(shop, { at: `${WEDNESDAY} 08:00` }) // booked, still to come
    await createJob(shop, { at: `${TUESDAY} 08:00`, status: 'cancelled' }) // not a visit
    await createJob(shop, { at: '2020-01-07 08:00' }) // booked, but its window has passed
    await createJob(shop, {
      at: '2020-01-07 12:00',
      status: 'done',
      technicianId: shop.mike.id,
      completedAt: new Date('2020-01-07T21:00:00Z'), // 2 PM in Phoenix
    })

    const res = await getAs(shop, '/api/customers')
    expect(res.body.customers[0]).toMatchObject({
      nextVisitDate: WEDNESDAY,
      lastVisitDate: '2020-01-07',
    })
  })

  it("never returns another contractor's customers", async () => {
    const shop = await createShop('desert')
    const other = await createShop('other')
    const res = await getAs(shop, '/api/customers?q=maria')
    expect(res.body.customers.map((c: { id: string }) => c.id)).toEqual([shop.customer.id])
    expect(res.body.total).toBe(1)
    expect(JSON.stringify(res.body)).not.toContain(other.customer.id)
  })

  it('treats % and _ as plain characters', async () => {
    const shop = await createShop('desert')
    const res = await getAs(shop, '/api/customers?q=%25%25')
    expect(res.body.customers).toEqual([])
  })
})

describe('POST /api/customers', () => {
  function postAs(shop: Shop, body: object) {
    return request(app).post('/api/customers').set('Cookie', shop.cookie).send(body)
  }

  it('adds a customer for the office, without an address', async () => {
    const shop = await createShop('desert')
    const res = await postAs(shop, {
      name: ' Tom Reyes ',
      phone: '(602) 555-0144',
      email: '',
    }).expect(201)

    const [saved] = await db.select().from(customers).where(eq(customers.id, res.body.id))
    expect(saved).toMatchObject({
      name: 'Tom Reyes',
      phone: '+16025550144',
      email: null,
      source: 'office',
    })
  })

  it('saves the address in the same step', async () => {
    const shop = await createShop('desert')
    const res = await postAs(shop, {
      name: 'Tom Reyes',
      phone: '6025550144',
      property: { street: '88 W Main St', unit: '', city: 'Mesa', state: 'az', zip: '85201' },
    }).expect(201)

    const saved = await db.select().from(properties).where(eq(properties.customerId, res.body.id))
    expect(saved).toEqual([
      expect.objectContaining({
        street: '88 W Main St',
        unit: null,
        city: 'Mesa',
        state: 'AZ',
        zip: '85201',
      }),
    ])
  })

  it('needs the whole address once a street is typed, and a real phone', async () => {
    const shop = await createShop('desert')
    const res = await postAs(shop, {
      name: 'Tom Reyes',
      phone: '555',
      property: { street: '88 W Main St', city: '', state: 'AZ', zip: '' },
    }).expect(400)
    expect(Object.keys(res.body.error.details).sort()).toEqual([
      'phone',
      'property.city',
      'property.zip',
    ])
  })
})

describe('GET /api/customers/:customerId', () => {
  it('returns the customer, their addresses and their jobs, upcoming first', async () => {
    const shop = await createShop('desert')
    await db
      .update(properties)
      .set({ equipmentBrand: 'Carrier', equipmentYear: 2014, notes: 'Gate 4411' })
      .where(eq(properties.id, shop.property.id))
    await createJob(shop, { at: `${WEDNESDAY} 08:00` })
    await createJob(shop, { at: `${TUESDAY} 08:00`, technicianId: shop.mike.id })
    await createJob(shop, {
      at: '2020-01-07 08:00',
      status: 'done',
      technicianId: shop.mike.id,
      completedAt: new Date('2020-01-07T18:00:00Z'),
    })
    await createJob(shop, { at: '2021-03-02 08:00', status: 'cancelled' })
    // Abandoned booking attempts are not history.
    await createJob(shop, { at: `${TUESDAY} 12:00`, status: 'held', holdExpiresAt: new Date() })
    await createJob(shop, { at: `${TUESDAY} 12:00`, status: 'expired' })

    const res = await getAs(shop, `/api/customers/${shop.customer.id}`)
    expect(res.body.customer).toEqual({
      id: shop.customer.id,
      name: 'Maria Lopez',
      phone: '+16025550111',
      email: null,
      notes: null,
      source: 'office',
      createdAt: expect.any(String),
    })
    expect(res.body.properties).toEqual([
      {
        id: shop.property.id,
        street: '12 Palm St',
        unit: null,
        city: 'Phoenix',
        state: 'AZ',
        zip: '85004',
        equipmentBrand: 'Carrier',
        equipmentYear: 2014,
        notes: 'Gate 4411',
      },
    ])
    expect(
      res.body.jobs.map((job: { date: string; status: string; upcoming: boolean }) => [
        job.date,
        job.status,
        job.upcoming,
      ]),
    ).toEqual([
      [TUESDAY, 'booked', true],
      [WEDNESDAY, 'booked', true],
      ['2021-03-02', 'cancelled', false],
      ['2020-01-07', 'done', false],
    ])
    expect(res.body.jobs[0]).toEqual({
      id: expect.any(String),
      status: 'booked',
      upcoming: true,
      propertyId: shop.property.id,
      date: TUESDAY,
      dateLabel: 'Jan 8, 2030',
      windowLabel: '8 AM–12 PM',
      serviceName: 'AC repair',
      problem: 'AC blowing warm air',
      technicianName: 'Mike',
    })
    expect(res.body.jobs[1].technicianName).toBeNull()
    expect(res.body.jobsTotal).toBe(4)
  })

  it("can't open another contractor's customer", async () => {
    const shop = await createShop('desert')
    const other = await createShop('other')
    const res = await request(app)
      .get(`/api/customers/${other.customer.id}`)
      .set('Cookie', shop.cookie)
      .expect(404)
    expect(res.body.error).toEqual({ code: 'not_found', message: 'That customer wasn’t found.' })
  })
})
