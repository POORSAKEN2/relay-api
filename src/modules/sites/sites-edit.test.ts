import { and, eq } from 'drizzle-orm'
import request from 'supertest'
import { beforeEach, expect, it } from 'vitest'
import {
  createShop,
  createTenant,
  createUser,
  resetDb,
  signIn,
  signInTechnician,
} from '../../../test/helpers.ts'
import { createApp } from '../../app.ts'
import { db } from '../../db/client.ts'
import { auditEvents } from '../../db/schema.ts'
import { siteUrl } from '../../lib/tenant-url.ts'

const app = createApp()
beforeEach(resetDb)

const basics = {
  design: 'clean',
  headline: 'Cool again today',
  intro: 'AC repair across Phoenix.',
  about: '',
  licenseNumber: ' AZ ROC #123456 ',
  city: 'Phoenix',
  region: 'az',
  citiesServed: ['Phoenix', 'Mesa'],
  emergencyService: true,
  showPrices: false,
}

it('offers a prefilled form before the first save', async () => {
  const shop = await createShop('desert')
  const res = await request(app).get('/api/site').set('Cookie', shop.cookie).expect(200)
  expect(res.body).toMatchObject({
    saved: false,
    liveUrl: siteUrl('desert'),
    publishedAt: null,
    reviews: [],
    faqs: [],
    photos: [],
  })
  expect(res.body.site).toMatchObject({
    design: 'breeze',
    headline: 'AC and heating repair, booked online',
    city: '',
    showPrices: true,
  })
})

it('saves the basics and records who did', async () => {
  const shop = await createShop('desert')
  const res = await request(app)
    .put('/api/site')
    .set('Cookie', shop.cookie)
    .send(basics)
    .expect(200)
  expect(res.body.saved).toBe(true)
  expect(res.body.site).toEqual({
    ...basics,
    about: null,
    licenseNumber: 'AZ ROC #123456',
    region: 'AZ',
  })
  const events = await db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.tenantId, shop.tenant.id), eq(auditEvents.action, 'site.updated')))
  expect(events).toHaveLength(1)
})

it('marks the fields it refuses', async () => {
  const shop = await createShop('desert')
  const res = await request(app)
    .put('/api/site')
    .set('Cookie', shop.cookie)
    .send({ ...basics, headline: ' ', region: 'Arizona' })
    .expect(400)
  expect(Object.keys(res.body.error.details)).toEqual(
    expect.arrayContaining(['headline', 'region']),
  )
})

it('publishes only a saved site with a service, then shows it on its host', async () => {
  const empty = await createTenant('empty')
  const owner = await createUser('owner', empty.id)
  const ownerCookie = await signIn(owner.email)
  await request(app)
    .post('/api/site/publish')
    .set('Cookie', ownerCookie)
    .expect(409)
    .expect((res) => expect(res.body.error.code).toBe('site_not_saved'))
  await request(app).put('/api/site').set('Cookie', ownerCookie).send(basics).expect(200)
  await request(app)
    .post('/api/site/publish')
    .set('Cookie', ownerCookie)
    .expect(409)
    .expect((res) => expect(res.body.error.code).toBe('site_incomplete'))

  const shop = await createShop('desert')
  await request(app).put('/api/site').set('Cookie', shop.cookie).send(basics).expect(200)
  const published = await request(app)
    .post('/api/site/publish')
    .set('Cookie', shop.cookie)
    .expect(200)
  expect(published.body.publishedAt).toEqual(expect.any(String))
  await request(app).get('/').set('Host', 'desert.site.localhost').expect(200)

  await request(app).post('/api/site/unpublish').set('Cookie', shop.cookie).expect(200)
  await request(app).get('/').set('Host', 'desert.site.localhost').expect(404)
})

it('previews an unpublished site for staff', async () => {
  const shop = await createShop('desert')
  await request(app).get('/api/site/preview').set('Cookie', shop.cookie).expect(409)
  await request(app).put('/api/site').set('Cookie', shop.cookie).send(basics).expect(200)
  const res = await request(app).get('/api/site/preview').set('Cookie', shop.cookie).expect(200)
  expect(res.headers['content-type']).toBe('text/html; charset=utf-8')
  expect(res.text).toContain('Cool again today')
})

it('keeps each contractor to their own site', async () => {
  const desert = await createShop('desert')
  const other = await createShop('other')
  await request(app).put('/api/site').set('Cookie', desert.cookie).send(basics).expect(200)
  const res = await request(app).get('/api/site').set('Cookie', other.cookie).expect(200)
  expect(res.body.saved).toBe(false)
})

it('is for owner and office only', async () => {
  const shop = await createShop('desert')
  await request(app).get('/api/site').expect(401)
  const technicianCookie = await signInTechnician(shop.mike)
  await request(app).get('/api/site').set('Cookie', technicianCookie).expect(403)
})
