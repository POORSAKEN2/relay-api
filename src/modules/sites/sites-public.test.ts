import { eq } from 'drizzle-orm'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createShop, createSite, resetDb } from '../../../test/helpers.ts'
import { createApp } from '../../app.ts'
import { db } from '../../db/client.ts'
import { sitePhotos, tenants } from '../../db/schema.ts'
import { assetUrl } from './site-assets.ts'
import * as queries from './sites.queries.ts'

const app = createApp()
const HOST = 'desert.site.localhost'
beforeEach(resetDb)

describe('GET / on a site host', () => {
  it('renders a published site', async () => {
    const shop = await createShop('desert')
    await createSite(shop.tenant.id)
    const res = await request(app).get('/').set('Host', HOST).expect(200)
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(res.headers['cache-control']).toBe('no-cache')
    expect(res.text).toContain('Cool again today')
  })

  it.each([
    ['an unknown contractor', 'nobody.site.localhost', async (_tenantId: string) => {}],
    ['a contractor with no site', HOST, async (_tenantId: string) => {}],
    [
      'an unpublished site',
      HOST,
      async (tenantId: string) => {
        await createSite(tenantId, { publishedAt: null })
      },
    ],
    [
      'a suspended contractor',
      HOST,
      async (tenantId: string) => {
        await createSite(tenantId)
        await db.update(tenants).set({ status: 'suspended' }).where(eq(tenants.id, tenantId))
      },
    ],
  ])('is a plain 404 for %s', async (_name, host, arrange) => {
    const shop = await createShop('desert')
    await arrange(shop.tenant.id)
    const res = await request(app).get('/').set('Host', host).expect(404)
    expect(res.text).toContain('This page isn’t here.')
    expect(res.text).not.toContain('desert HVAC')
  })

  it('is a 404 for any other path', async () => {
    const shop = await createShop('desert')
    await createSite(shop.tenant.id)
    await request(app).get('/about').set('Host', HOST).expect(404)
  })

  it('is a bare 500 page when the database fails', async () => {
    const shop = await createShop('desert')
    await createSite(shop.tenant.id)
    vi.spyOn(queries, 'findSite').mockRejectedValueOnce(new Error('database down'))
    const res = await request(app).get('/').set('Host', HOST).expect(500)
    expect(res.text).toContain('Something went wrong. Try again in a minute.')
    expect(res.text).not.toContain('database down')
  })

  it('leaves the API and other hosts alone', async () => {
    await request(app).get('/health').set('Host', 'desert.localhost').expect(200, { ok: true })
    await request(app).get(assetUrl('breeze.css')).set('Host', HOST).expect(200)
  })
})

describe('site assets and photos', () => {
  it('serves a stylesheet for a year', async () => {
    const res = await request(app).get(assetUrl('breeze.css')).expect(200)
    expect(res.headers['content-type']).toBe('text/css; charset=utf-8')
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable')
    await request(app).get('/api/site/assets/nope.css').expect(404)
  })

  it('serves a photo to anyone', async () => {
    const shop = await createShop('desert')
    const data = Buffer.from([0xff, 0xd8, 0xff, 0x01])
    const [photo] = await db
      .insert(sitePhotos)
      .values({
        tenantId: shop.tenant.id,
        kind: 'work',
        contentType: 'image/jpeg',
        data,
        altText: 'Van',
        createdBy: shop.office.id,
      })
      .returning()
    const res = await request(app).get(`/api/site/photos/${photo.id}`).expect(200)
    expect(res.headers['content-type']).toBe('image/jpeg')
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(Buffer.compare(res.body, data)).toBe(0)
    await request(app).get('/api/site/photos/00000000-0000-4000-8000-000000000009').expect(404)
    await request(app).get('/api/site/photos/abc').expect(400)
  })
})
