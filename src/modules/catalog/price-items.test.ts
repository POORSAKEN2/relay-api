import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createShop, resetDb, type Shop, signInTechnician } from '../../../test/helpers.ts'
import { createApp } from '../../app.ts'
import { db } from '../../db/client.ts'
import { auditEvents } from '../../db/schema.ts'

vi.mock('../../realtime/index.ts', () => ({ emitToTenant: vi.fn() }))

const app = createApp()

beforeEach(async () => {
  await resetDb()
})

function addPrice(shop: Shop, body: object) {
  return request(app).post('/api/price-items').set('Cookie', shop.cookie).send(body)
}

function listPrices(shop: Shop) {
  return request(app).get('/api/price-items').set('Cookie', shop.cookie).expect(200)
}

describe('repair prices', () => {
  it('adds, edits, archives and restores a price, active ones first by name', async () => {
    const shop = await createShop('desert')
    const contactor = (
      await addPrice(shop, { name: ' Contactor replacement ', priceCents: 16500 }).expect(201)
    ).body.priceItem
    const capacitor = (
      await addPrice(shop, { name: 'Capacitor replacement', priceCents: 18500 }).expect(201)
    ).body.priceItem
    expect(contactor).toEqual({
      id: expect.any(String),
      name: 'Contactor replacement',
      priceCents: 16500,
      archived: false,
    })

    await request(app)
      .patch(`/api/price-items/${capacitor.id}`)
      .set('Cookie', shop.cookie)
      .send({ name: 'Capacitor replacement', priceCents: 19500 })
      .expect(200)
    await request(app)
      .post(`/api/price-items/${contactor.id}/archive`)
      .set('Cookie', shop.cookie)
      .expect(200)

    const listed = (await listPrices(shop)).body.priceItems
    expect(
      listed.map((item: { name: string; priceCents: number; archived: boolean }) => [
        item.name,
        item.priceCents,
        item.archived,
      ]),
    ).toEqual([
      ['Capacitor replacement', 19500, false],
      ['Contactor replacement', 16500, true],
    ])

    const restored = await request(app)
      .post(`/api/price-items/${contactor.id}/restore`)
      .set('Cookie', shop.cookie)
      .expect(200)
    expect(restored.body.priceItem.archived).toBe(false)

    const events = await db.select().from(auditEvents).orderBy(auditEvents.createdAt)
    const actions = events.map((event) => event.action)
    expect(actions).toEqual([
      'price_item.added',
      'price_item.added',
      'price_item.updated',
      'price_item.archived',
      'price_item.restored',
    ])
  })

  it('explains a bad name or price', async () => {
    const shop = await createShop('desert')
    const empty = await addPrice(shop, { name: ' ', priceCents: -1 }).expect(400)
    expect(empty.body.error.details).toEqual({
      name: ['Enter a name'],
      priceCents: ['Enter a price from $0 to $10,000'],
    })
    const long = await addPrice(shop, { name: 'x'.repeat(101), priceCents: 1_000_001 }).expect(400)
    expect(long.body.error.details).toEqual({
      name: ['Keep the name to 100 characters or fewer'],
      priceCents: ['Enter a price from $0 to $10,000'],
    })
    await addPrice(shop, { name: 'Free check', priceCents: 0 }).expect(201)
  })

  it("keeps each contractor's prices to themselves, and is for staff only", async () => {
    const shop = await createShop('desert')
    const other = await createShop('other')
    const theirs = (await addPrice(other, { name: 'Contactor', priceCents: 100 }).expect(201)).body
      .priceItem

    expect((await listPrices(shop)).body.priceItems).toEqual([])
    for (const id of [theirs.id, randomUUID()]) {
      const res = await request(app)
        .patch(`/api/price-items/${id}`)
        .set('Cookie', shop.cookie)
        .send({ name: 'Mine now', priceCents: 1 })
        .expect(404)
      expect(res.body.error.message).toBe('That price isn’t on your list.')
    }
    await request(app).get('/api/price-items').expect(401)
    await request(app)
      .get('/api/price-items')
      .set('Cookie', await signInTechnician(shop.mike))
      .expect(403)
  })
})
