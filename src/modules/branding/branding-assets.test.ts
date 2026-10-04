import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'
import { createTenant, createUser, resetDb, signIn } from '../../../test/helpers.ts'
import { createApp } from '../../app.ts'
import { db } from '../../db/client.ts'
import { auditEvents, brandingAssets, brandingVersions } from '../../db/schema.ts'
import { DEFAULT_COLORS } from './branding.service.ts'

const app = createApp()

beforeEach(resetDb)

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 7),
])
const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
)

async function setup() {
  const desert = await createTenant('desert')
  const admin = await createUser('superadmin', null)
  const cookie = await signIn(admin.email)
  const base = `/api/admin/tenants/${desert.id}/branding`
  return { desert, admin, cookie, base }
}

function upload(path: string, cookie: string, body: Buffer, type = 'application/octet-stream') {
  return request(app).put(path).set('Cookie', cookie).set('Content-Type', type).send(body)
}

function assetId(url: string) {
  return url.split('/').at(-1)!
}

describe('PUT /api/admin/tenants/:tenantId/branding/logo and /favicon', () => {
  it('saves a PNG logo as a new version and keeps the colors and favicon', async () => {
    const { desert, admin, cookie, base } = await setup()
    await request(app)
      .put(base)
      .set('Cookie', cookie)
      .send({ primaryColor: '#111111', accentColor: '#222222' })
      .expect(200)
    const favicon = await upload(`${base}/favicon`, cookie, SVG, 'image/svg+xml').expect(200)

    const res = await upload(`${base}/logo`, cookie, PNG, 'image/png').expect(200)

    expect(res.body).toMatchObject({
      primaryColor: '#111111',
      accentColor: '#222222',
      logoUrl: expect.stringMatching(/^\/branding\/assets\/[0-9a-f-]{36}$/),
      faviconUrl: favicon.body.faviconUrl,
    })
    const [asset] = await db
      .select()
      .from(brandingAssets)
      .where(eq(brandingAssets.id, assetId(res.body.logoUrl)))
    expect(asset).toMatchObject({ tenantId: desert.id, kind: 'logo', contentType: 'image/png' })
    expect(Buffer.compare(asset.data, PNG)).toBe(0)
    const versions = await db
      .select()
      .from(brandingVersions)
      .where(eq(brandingVersions.tenantId, desert.id))
    expect(versions).toHaveLength(3)
    const [event] = await db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.tenantId, desert.id), eq(auditEvents.action, 'branding.logo_updated')),
      )
    expect(event).toMatchObject({
      actorUserId: admin.id,
      entityType: 'tenant',
      entityId: desert.id,
      data: { assetId: asset.id },
    })
  })

  it('reads the type from the bytes, not the header', async () => {
    const { cookie, base } = await setup()

    const res = await upload(`${base}/favicon`, cookie, SVG, 'image/png').expect(200)

    const [asset] = await db
      .select({ contentType: brandingAssets.contentType, kind: brandingAssets.kind })
      .from(brandingAssets)
      .where(eq(brandingAssets.id, assetId(res.body.faviconUrl)))
    expect(asset).toEqual({ contentType: 'image/svg+xml', kind: 'favicon' })
    expect(res.body.logoUrl).toBeNull()
    expect(res.body.primaryColor).toBe(DEFAULT_COLORS.primaryColor)
  })

  it.each([
    [
      'a JPEG',
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]),
      'unsupported_image',
      'Use a PNG or SVG file.',
    ],
    ['an empty body', Buffer.alloc(0), 'unsupported_image', 'Use a PNG or SVG file.'],
    [
      'an SVG with a script',
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      'unsafe_svg',
      'This SVG has scripts or links in it. Export it again as a plain SVG.',
    ],
  ])('refuses %s', async (_label, body, code, message) => {
    const { desert, cookie, base } = await setup()

    const res = await upload(`${base}/logo`, cookie, body).expect(400)

    expect(res.body.error).toEqual({ code, message })
    const versions = await db
      .select()
      .from(brandingVersions)
      .where(eq(brandingVersions.tenantId, desert.id))
    expect(versions).toEqual([])
  })

  it('refuses a logo over 512 KB and a favicon over 100 KB', async () => {
    const { cookie, base } = await setup()
    const big = (size: number) => Buffer.concat([PNG, Buffer.alloc(size - PNG.length, 1)])

    const logo = await upload(`${base}/logo`, cookie, big(512 * 1024 + 1)).expect(400)
    expect(logo.body.error).toEqual({
      code: 'image_too_large',
      message: 'The logo must be 512 KB or smaller.',
    })
    const favicon = await upload(`${base}/favicon`, cookie, big(100 * 1024 + 1)).expect(400)
    expect(favicon.body.error).toEqual({
      code: 'image_too_large',
      message: 'The favicon must be 100 KB or smaller.',
    })
    await upload(`${base}/logo`, cookie, big(512 * 1024)).expect(200)
  })

  it('answers 413 for a body over 1 MB', async () => {
    const { cookie, base } = await setup()

    await upload(`${base}/logo`, cookie, Buffer.alloc(1024 * 1024 + 1, 1)).expect(413)
  })

  it('404s for an unknown contractor and needs a signed-in superadmin', async () => {
    const { desert, cookie } = await setup()
    const owner = await createUser('owner', desert.id)
    const path = `/api/admin/tenants/${desert.id}/branding/logo`

    await upload(`/api/admin/tenants/${randomUUID()}/branding/logo`, cookie, PNG).expect(404)
    await request(app).put(path).send(PNG).expect(401)
    await upload(path, await signIn(owner.email), PNG).expect(403)
  })
})

describe('DELETE /api/admin/tenants/:tenantId/branding/logo and /favicon', () => {
  it('saves a version without the logo and keeps the favicon', async () => {
    const { desert, admin, cookie, base } = await setup()
    await upload(`${base}/logo`, cookie, PNG).expect(200)
    const favicon = await upload(`${base}/favicon`, cookie, SVG).expect(200)

    const res = await request(app).delete(`${base}/logo`).set('Cookie', cookie).expect(200)

    expect(res.body.logoUrl).toBeNull()
    expect(res.body.faviconUrl).toBe(favicon.body.faviconUrl)
    const [event] = await db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.tenantId, desert.id), eq(auditEvents.action, 'branding.logo_removed')),
      )
    expect(event).toMatchObject({ actorUserId: admin.id, data: {} })
  })

  it('still saves a version when there is nothing to remove', async () => {
    const { desert, cookie, base } = await setup()

    const res = await request(app).delete(`${base}/favicon`).set('Cookie', cookie).expect(200)

    expect(res.body.faviconUrl).toBeNull()
    const versions = await db
      .select()
      .from(brandingVersions)
      .where(eq(brandingVersions.tenantId, desert.id))
    expect(versions).toHaveLength(1)
  })

  it('needs a superadmin', async () => {
    const { desert, base } = await setup()
    const owner = await createUser('owner', desert.id)

    await request(app)
      .delete(`${base}/logo`)
      .set('Cookie', await signIn(owner.email))
      .expect(403)
  })
})

describe('GET /api/branding/assets/:assetId', () => {
  it('serves the bytes to anyone, with safe, long-lived headers', async () => {
    const { cookie, base } = await setup()
    const uploaded = await upload(`${base}/logo`, cookie, SVG).expect(200)

    const res = await request(app).get(`/api${uploaded.body.logoUrl}`).buffer(true).expect(200)

    expect(res.headers['content-type']).toMatch(/^image\/svg\+xml/)
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['content-security-policy']).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    )
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable')
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin')
    expect(Buffer.from(res.body).toString()).toBe(SVG.toString())
  })

  it('serves a PNG with its type', async () => {
    const { cookie, base } = await setup()
    const uploaded = await upload(`${base}/favicon`, cookie, PNG).expect(200)

    const res = await request(app).get(`/api${uploaded.body.faviconUrl}`).expect(200)

    expect(res.headers['content-type']).toBe('image/png')
    expect(Buffer.compare(res.body, PNG)).toBe(0)
  })

  it('404s for an unknown or malformed id', async () => {
    const unknown = await request(app).get(`/api/branding/assets/${randomUUID()}`).expect(404)
    expect(unknown.body.error).toEqual({ code: 'not_found', message: 'Image not found' })
    await request(app).get('/api/branding/assets/not-a-uuid').expect(404)
  })
})
