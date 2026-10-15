import request from 'supertest'
import { beforeEach, expect, it } from 'vitest'
import { createShop, resetDb, type Shop } from '../../../test/helpers.ts'
import { createApp } from '../../app.ts'

const app = createApp()
beforeEach(resetDb)

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(64, 1)])
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 1),
])
const upload = (shop: Shop, kind: string, body: Buffer, alt = 'Our van') =>
  request(app)
    .post(`/api/site/photos?kind=${kind}&alt=${encodeURIComponent(alt)}`)
    .set('Cookie', shop.cookie)
    .set('Content-Type', 'image/jpeg')
    .send(body)

it('adds a work photo anyone can then load', async () => {
  const shop = await createShop('desert')
  const res = await upload(shop, 'work', JPEG).expect(200)
  expect(res.body.photos).toEqual([
    {
      id: expect.any(String),
      kind: 'work',
      altText: 'Our van',
      url: `/site/photos/${res.body.photos[0].id}`,
    },
  ])
  await request(app).get(`/api${res.body.photos[0].url}`).expect(200)
})

it('keeps one hero photo', async () => {
  const shop = await createShop('desert')
  const first = await upload(shop, 'hero', JPEG).expect(200)
  const second = await upload(shop, 'hero', JPEG, 'New van').expect(200)
  expect(second.body.photos).toHaveLength(1)
  expect(second.body.photos[0].altText).toBe('New van')
  await request(app).get(`/api/site/photos/${first.body.photos[0].id}`).expect(404)
})

it.each([
  ['a PNG', PNG],
  ['a photo over 1 MB', Buffer.concat([JPEG, Buffer.alloc(1_048_576)])],
  ['an empty body', Buffer.alloc(0)],
])('refuses %s', async (_name, body) => {
  const shop = await createShop('desert')
  const res = await upload(shop, 'work', body).expect(400)
  expect(res.body.error).toEqual({
    code: 'bad_photo',
    message: 'Photos must be JPEG or WebP, up to 1 MB.',
  })
})

it('refuses a photo with no description', async () => {
  const shop = await createShop('desert')
  await upload(shop, 'work', JPEG, ' ').expect(400)
})

it('stops at 12 work photos', async () => {
  const shop = await createShop('desert')
  for (let i = 0; i < 12; i++) await upload(shop, 'work', JPEG).expect(200)
  const res = await upload(shop, 'work', JPEG).expect(409)
  expect(res.body.error.code).toBe('too_many_photos')
})

it('deletes only the contractor’s own photo', async () => {
  const desert = await createShop('desert')
  const other = await createShop('other')
  const res = await upload(desert, 'work', JPEG).expect(200)
  const id = res.body.photos[0].id
  await request(app).delete(`/api/site/photos/${id}`).set('Cookie', other.cookie).expect(404)
  const deleted = await request(app)
    .delete(`/api/site/photos/${id}`)
    .set('Cookie', desert.cookie)
    .expect(200)
  expect(deleted.body.photos).toEqual([])
})
