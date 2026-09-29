import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'
import { createShop, resetDb } from '../../../test/helpers.ts'
import { createApp } from '../../app.ts'
import { db } from '../../db/client.ts'
import { customers } from '../../db/schema.ts'

const app = createApp()

beforeEach(resetDb)

describe('GET /api/customers', () => {
  it('finds customers by name or phone digits, with their addresses', async () => {
    const shop = await createShop('desert')
    await db
      .insert(customers)
      .values({ tenantId: shop.tenant.id, name: 'Bob Marley', source: 'office' })

    const byName = await request(app)
      .get('/api/customers?q=lopez')
      .set('Cookie', shop.cookie)
      .expect(200)
    expect(byName.body.customers).toEqual([
      {
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
          },
        ],
      },
    ])

    const byPhone = await request(app)
      .get('/api/customers?q=(602) 555-01')
      .set('Cookie', shop.cookie)
      .expect(200)
    expect(byPhone.body.customers.map((c: { name: string }) => c.name)).toEqual(['Maria Lopez'])
  })

  it("never returns another contractor's customers", async () => {
    const shop = await createShop('desert')
    const other = await createShop('other')
    const res = await request(app)
      .get('/api/customers?q=maria')
      .set('Cookie', shop.cookie)
      .expect(200)
    expect(res.body.customers.map((c: { id: string }) => c.id)).toEqual([shop.customer.id])
    expect(JSON.stringify(res.body)).not.toContain(other.customer.id)
  })

  it('returns nothing until at least 2 characters are typed', async () => {
    const shop = await createShop('desert')
    const res = await request(app).get('/api/customers?q=m').set('Cookie', shop.cookie).expect(200)
    expect(res.body.customers).toEqual([])
  })

  it('treats % and _ as plain characters', async () => {
    const shop = await createShop('desert')
    const res = await request(app)
      .get('/api/customers?q=%25%25')
      .set('Cookie', shop.cookie)
      .expect(200)
    expect(res.body.customers).toEqual([])
  })
})
