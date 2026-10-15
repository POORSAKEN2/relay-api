import request from 'supertest'
import { beforeEach, expect, it } from 'vitest'
import { createShop, resetDb } from '../../../test/helpers.ts'
import { createApp } from '../../app.ts'

const app = createApp()
beforeEach(resetDb)

const review = (body: string) => ({ authorName: 'Maria G.', place: 'Mesa', rating: 5, body })

it('adds reviews in order, edits and deletes them', async () => {
  const shop = await createShop('desert')
  const put = (path: string, body: object) =>
    request(app).put(path).set('Cookie', shop.cookie).send(body)
  await request(app)
    .post('/api/site/reviews')
    .set('Cookie', shop.cookie)
    .send(review('First'))
    .expect(200)
  const added = await request(app)
    .post('/api/site/reviews')
    .set('Cookie', shop.cookie)
    .send({ ...review('Second'), place: '' })
    .expect(200)
  expect(added.body.reviews.map((r: { body: string }) => r.body)).toEqual(['First', 'Second'])
  expect(added.body.reviews[1].place).toBeNull()

  const [first, second] = added.body.reviews
  const edited = await put(`/api/site/reviews/${first.id}`, review('First, edited')).expect(200)
  expect(edited.body.reviews[0].body).toBe('First, edited')

  const reordered = await put('/api/site/reviews/order', { ids: [second.id, first.id] }).expect(200)
  expect(reordered.body.reviews.map((r: { id: string }) => r.id)).toEqual([second.id, first.id])

  const deleted = await request(app)
    .delete(`/api/site/reviews/${second.id}`)
    .set('Cookie', shop.cookie)
    .expect(200)
  expect(deleted.body.reviews).toHaveLength(1)
})

it('refuses an order made before another tab deleted a review', async () => {
  const shop = await createShop('desert')
  await request(app)
    .post('/api/site/reviews')
    .set('Cookie', shop.cookie)
    .send(review('A'))
    .expect(200)
  const res = await request(app)
    .post('/api/site/reviews')
    .set('Cookie', shop.cookie)
    .send(review('B'))
    .expect(200)
  const [a, b] = res.body.reviews
  await request(app).delete(`/api/site/reviews/${b.id}`).set('Cookie', shop.cookie).expect(200)
  const stale = await request(app)
    .put('/api/site/reviews/order')
    .set('Cookie', shop.cookie)
    .send({ ids: [b.id, a.id] })
    .expect(409)
  expect(stale.body.error).toEqual({
    code: 'list_changed',
    message: 'Your list changed since this page loaded. Refresh and try again.',
  })
})

it('refuses a rating of 6', async () => {
  const shop = await createShop('desert')
  await request(app)
    .post('/api/site/reviews')
    .set('Cookie', shop.cookie)
    .send({ ...review('x'), rating: 6 })
    .expect(400)
})

it('keeps each contractor to their own reviews and questions', async () => {
  const desert = await createShop('desert')
  const other = await createShop('other')
  const r = await request(app)
    .post('/api/site/reviews')
    .set('Cookie', desert.cookie)
    .send(review('Mine'))
    .expect(200)
  const f = await request(app)
    .post('/api/site/faqs')
    .set('Cookie', desert.cookie)
    .send({ question: 'How do I pay?', answer: 'Card.' })
    .expect(200)
  await request(app)
    .put(`/api/site/reviews/${r.body.reviews[0].id}`)
    .set('Cookie', other.cookie)
    .send(review('Theirs'))
    .expect(404)
  await request(app)
    .delete(`/api/site/faqs/${f.body.faqs[0].id}`)
    .set('Cookie', other.cookie)
    .expect(404)
})

it('handles questions like reviews', async () => {
  const shop = await createShop('desert')
  const q = (question: string) =>
    request(app)
      .post('/api/site/faqs')
      .set('Cookie', shop.cookie)
      .send({ question, answer: 'Yes.' })
      .expect(200)
  await q('One?')
  const res = await q('Two?')
  const [one, two] = res.body.faqs
  const reordered = await request(app)
    .put('/api/site/faqs/order')
    .set('Cookie', shop.cookie)
    .send({ ids: [two.id, one.id] })
    .expect(200)
  expect(reordered.body.faqs.map((f: { question: string }) => f.question)).toEqual(['Two?', 'One?'])
})
