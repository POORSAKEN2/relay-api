import { eq } from 'drizzle-orm'
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'
import { createShop, resetDb, type Shop, signInTechnician } from '../../../test/helpers.ts'
import { createApp } from '../../app.ts'
import { db } from '../../db/client.ts'
import { consentEvents, customerImports, customers, properties } from '../../db/schema.ts'

const app = createApp()

beforeEach(resetDb)

function postAs(shop: Shop, path: string, body: object) {
  return request(app).post(path).set('Cookie', shop.cookie).send(body)
}

// createShop already has Maria Lopez, +16025550111.
const rows = [
  {
    row: 2,
    name: 'Tom',
    lastName: 'Reyes',
    phone: '602-555-0144',
    street: '88 W Main St',
    city: 'Mesa',
    state: 'Arizona',
    zip: '85201',
    equipmentBrand: 'Trane',
    equipmentAge: '10',
  },
  { row: 3, name: 'maria  lopez', phone: '(602) 555-0111' }, // already in Relay
  { row: 4, name: 'Tom Reyes', phone: '6025550144' }, // repeats row 2
  { row: 5, name: 'Ana Reyes', phone: '602-555-0144' }, // same phone, another person
  { row: 6, name: '', phone: '555' }, // needs fixing
]

describe('POST /api/customers/imports/check', () => {
  it('sorts every row and saves nothing', async () => {
    const shop = await createShop('desert')
    const res = await postAs(shop, '/api/customers/imports/check', { rows }).expect(200)
    expect(res.body.rows).toEqual([
      { row: 2, status: 'ready', problems: [] },
      { row: 3, status: 'existing', problems: [] },
      { row: 4, status: 'repeated', problems: [] },
      { row: 5, status: 'ready', problems: [] },
      {
        row: 6,
        status: 'invalid',
        problems: ['Enter the customer’s name', 'Enter a 10-digit phone number'],
      },
    ])
    expect(res.body.counts).toEqual({ ready: 2, existing: 1, repeated: 1, invalid: 1 })
    expect(await db.$count(customers)).toBe(1)
  })

  it('takes a whole 5,000-row file but not one row more', async () => {
    const shop = await createShop('desert')
    const many = (count: number) =>
      Array.from({ length: count }, (_, i) => ({
        row: i + 2,
        name: `Customer ${i}`,
        phone: '6025550199',
      }))
    const big = await postAs(shop, '/api/customers/imports/check', { rows: many(5000) }).expect(200)
    expect(big.body.counts.ready).toBe(5000)
    const tooBig = await postAs(shop, '/api/customers/imports/check', { rows: many(5001) }).expect(
      400,
    )
    expect(tooBig.body.error.details.rows).toEqual(['Import up to 5,000 rows at a time'])
  })

  it('is for the owner and office only', async () => {
    const shop = await createShop('desert')
    const cookie = await signInTechnician(shop.mike)
    await request(app)
      .post('/api/customers/imports/check')
      .set('Cookie', cookie)
      .send({ rows })
      .expect(403)
  })
})

describe('POST /api/customers/imports', () => {
  it('imports the ready rows as one batch, without texting consent', async () => {
    const shop = await createShop('desert')
    const res = await postAs(shop, '/api/customers/imports', {
      fileName: 'customers.xlsx',
      rows,
    }).expect(201)
    expect(res.body).toEqual({
      importId: expect.any(String),
      created: 2,
      existing: 1,
      repeated: 1,
      invalid: 1,
    })

    const [batch] = await db
      .select()
      .from(customerImports)
      .where(eq(customerImports.id, res.body.importId))
    expect(batch).toMatchObject({
      tenantId: shop.tenant.id,
      createdBy: shop.office.id,
      fileName: 'customers.xlsx',
      createdCount: 2,
      skippedCount: 3,
      keptCount: null,
      undoneAt: null,
    })

    const imported = await db.select().from(customers).where(eq(customers.importId, batch.id))
    expect(imported.map((customer) => customer.name).sort()).toEqual(['Ana Reyes', 'Tom Reyes'])
    expect(
      imported.every(
        (customer) => customer.source === 'import' && customer.phone === '+16025550144',
      ),
    ).toBe(true)

    const tom = imported.find((customer) => customer.name === 'Tom Reyes')!
    const [address] = await db.select().from(properties).where(eq(properties.customerId, tom.id))
    expect(address).toMatchObject({
      street: '88 W Main St',
      city: 'Mesa',
      state: 'AZ',
      zip: '85201',
      equipmentBrand: 'Trane',
      equipmentYear: new Date().getFullYear() - 10,
    })
    expect(await db.$count(consentEvents)).toBe(0)
  })

  it('imports nothing the second time the same file comes in', async () => {
    const shop = await createShop('desert')
    await postAs(shop, '/api/customers/imports', { fileName: 'customers.xlsx', rows }).expect(201)
    const again = await postAs(shop, '/api/customers/imports', {
      fileName: 'customers.xlsx',
      rows,
    }).expect(422)
    expect(again.body.error).toEqual({
      code: 'nothing_to_import',
      message: 'Nothing to import: no row is ready.',
    })
    expect(await db.$count(customerImports)).toBe(1)
  })
})
