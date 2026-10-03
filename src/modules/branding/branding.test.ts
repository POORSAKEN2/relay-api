import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'
import { createTenant, createUser, resetDb, signIn } from '../../../test/helpers.ts'
import { createApp } from '../../app.ts'
import { db } from '../../db/client.ts'
import { brandingAssets, brandingVersions, tenants } from '../../db/schema.ts'
import { DEFAULT_COLORS } from './branding.service.ts'

const app = createApp()

beforeEach(resetDb)

describe('GET /api/branding', () => {
  it('returns the default colors for a contractor without branding', async () => {
    await createTenant('desert')
    const res = await request(app).get('/api/branding').set('X-Tenant-Host', 'desert.localhost')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      name: 'desert HVAC',
      slug: 'desert',
      ...DEFAULT_COLORS,
      logoUrl: null,
      faviconUrl: null,
    })
  })

  it('404s for an unknown contractor or a missing header', async () => {
    const unknown = await request(app).get('/api/branding').set('X-Tenant-Host', 'nope.localhost')
    expect(unknown.status).toBe(404)
    expect(unknown.body.error.code).toBe('not_found')
    await request(app).get('/api/branding').expect(404)
  })

  it('gives each contractor only its own branding', async () => {
    const desert = await createTenant('desert')
    await createTenant('other')
    const admin = await createUser('superadmin', null)
    await db.insert(brandingVersions).values({
      tenantId: desert.id,
      primaryColor: '#0f766e',
      accentColor: '#f59e0b',
      createdBy: admin.id,
    })

    const desertRes = await request(app)
      .get('/api/branding')
      .set('X-Tenant-Host', 'desert.localhost')
    const otherRes = await request(app).get('/api/branding').set('X-Tenant-Host', 'other.localhost')

    expect(desertRes.body.primaryColor).toBe('#0f766e')
    expect(otherRes.body.primaryColor).toBe(DEFAULT_COLORS.primaryColor)
  })

  it('answers 410 for a turned-off contractor', async () => {
    const desert = await createTenant('desert')
    await db.update(tenants).set({ status: 'suspended' }).where(eq(tenants.id, desert.id))

    const res = await request(app)
      .get('/api/branding')
      .set('X-Tenant-Host', 'desert.localhost')
      .expect(410)
    expect(res.body.error).toEqual({
      code: 'contractor_unavailable',
      message: 'This contractor is not taking bookings right now',
    })
  })
})

describe('PUT /api/admin/tenants/:tenantId/branding', () => {
  it('saves each change as a new version', async () => {
    const desert = await createTenant('desert')
    const admin = await createUser('superadmin', null)
    const cookie = await signIn(admin.email)
    const url = `/api/admin/tenants/${desert.id}/branding`

    const first = await request(app)
      .put(url)
      .set('Cookie', cookie)
      .send({ primaryColor: '#0F766E', accentColor: '#f59e0b' })
      .expect(200)
    expect(first.body.primaryColor).toBe('#0f766e')

    await request(app)
      .put(url)
      .set('Cookie', cookie)
      .send({ primaryColor: '#111111', accentColor: '#222222' })
      .expect(200)

    const versions = await db
      .select()
      .from(brandingVersions)
      .where(eq(brandingVersions.tenantId, desert.id))
    expect(versions).toHaveLength(2)
    const current = await request(app).get('/api/branding').set('X-Tenant-Host', 'desert.localhost')
    expect(current.body.primaryColor).toBe('#111111')
  })

  it('needs a signed-in superadmin', async () => {
    const desert = await createTenant('desert')
    const owner = await createUser('owner', desert.id)
    const url = `/api/admin/tenants/${desert.id}/branding`
    const colors = { primaryColor: '#111111', accentColor: '#222222' }

    await request(app).put(url).send(colors).expect(401)
    const forbidden = await request(app)
      .put(url)
      .set('Cookie', await signIn(owner.email))
      .send(colors)
      .expect(403)
    expect(forbidden.body.error.code).toBe('forbidden')
  })

  it('rejects a color that is not #rrggbb', async () => {
    const desert = await createTenant('desert')
    const admin = await createUser('superadmin', null)

    const res = await request(app)
      .put(`/api/admin/tenants/${desert.id}/branding`)
      .set('Cookie', await signIn(admin.email))
      .send({ primaryColor: 'red', accentColor: '#222222' })
      .expect(400)
    expect(res.body.error.details).toEqual({ primaryColor: ['Expected a hex color like #1d4ed8'] })
  })

  it('404s for an unknown contractor', async () => {
    const admin = await createUser('superadmin', null)
    await request(app)
      .put(`/api/admin/tenants/${randomUUID()}/branding`)
      .set('Cookie', await signIn(admin.email))
      .send({ primaryColor: '#111111', accentColor: '#222222' })
      .expect(404)
  })
})

describe('GET /api/admin/tenants/:tenantId/branding', () => {
  it("returns a contractor's current branding to a superadmin only", async () => {
    const desert = await createTenant('desert')
    const owner = await createUser('owner', desert.id)
    const admin = await createUser('superadmin', null)
    const url = `/api/admin/tenants/${desert.id}/branding`

    const res = await request(app)
      .get(url)
      .set('Cookie', await signIn(admin.email))
      .expect(200)
    expect(res.body).toMatchObject({ slug: 'desert', ...DEFAULT_COLORS })

    await request(app)
      .get(url)
      .set('Cookie', await signIn(owner.email))
      .expect(403)
  })
})

describe('branding assets in versions', () => {
  async function insertAsset(tenantId: string, createdBy: string, kind: 'logo' | 'favicon') {
    const [asset] = await db
      .insert(brandingAssets)
      .values({
        tenantId,
        kind,
        contentType: 'image/svg+xml',
        data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
        createdBy,
      })
      .returning()
    return asset
  }

  it('gives logo and favicon paths under the API', async () => {
    const desert = await createTenant('desert')
    const admin = await createUser('superadmin', null)
    const logo = await insertAsset(desert.id, admin.id, 'logo')
    const favicon = await insertAsset(desert.id, admin.id, 'favicon')
    await db.insert(brandingVersions).values({
      tenantId: desert.id,
      ...DEFAULT_COLORS,
      logoAssetId: logo.id,
      faviconAssetId: favicon.id,
      createdBy: admin.id,
    })

    const res = await request(app).get('/api/branding').set('X-Tenant-Host', 'desert.localhost')

    expect(res.body.logoUrl).toBe(`/branding/assets/${logo.id}`)
    expect(res.body.faviconUrl).toBe(`/branding/assets/${favicon.id}`)
  })

  it('keeps the logo and favicon when the colors are saved', async () => {
    const desert = await createTenant('desert')
    const admin = await createUser('superadmin', null)
    const logo = await insertAsset(desert.id, admin.id, 'logo')
    const favicon = await insertAsset(desert.id, admin.id, 'favicon')
    await db.insert(brandingVersions).values({
      tenantId: desert.id,
      ...DEFAULT_COLORS,
      logoAssetId: logo.id,
      faviconAssetId: favicon.id,
      createdBy: admin.id,
    })

    const res = await request(app)
      .put(`/api/admin/tenants/${desert.id}/branding`)
      .set('Cookie', await signIn(admin.email))
      .send({ primaryColor: '#111111', accentColor: '#222222' })
      .expect(200)

    expect(res.body).toMatchObject({
      primaryColor: '#111111',
      logoUrl: `/branding/assets/${logo.id}`,
      faviconUrl: `/branding/assets/${favicon.id}`,
    })
  })

  it("refuses a version that points at another contractor's asset", async () => {
    const desert = await createTenant('desert')
    const other = await createTenant('other')
    const admin = await createUser('superadmin', null)
    const othersLogo = await insertAsset(other.id, admin.id, 'logo')

    await expect(
      db.insert(brandingVersions).values({
        tenantId: desert.id,
        ...DEFAULT_COLORS,
        logoAssetId: othersLogo.id,
        createdBy: admin.id,
      }),
    ).rejects.toThrow()
  })
})
