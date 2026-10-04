import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'
import { createTenant, createUser, resetDb, signIn } from '../../../test/helpers.ts'
import { createApp } from '../../app.ts'
import { db } from '../../db/client.ts'
import { auditEvents } from '../../db/schema.ts'

const app = createApp()

beforeEach(resetDb)

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 7),
])

async function setup() {
  const desert = await createTenant('desert')
  const admin = await createUser('superadmin', null)
  const cookie = await signIn(admin.email)
  const base = `/api/admin/tenants/${desert.id}/branding`
  return { desert, admin, cookie, base }
}

function saveColors(base: string, cookie: string, primaryColor: string, accentColor: string) {
  return request(app)
    .put(base)
    .set('Cookie', cookie)
    .send({ primaryColor, accentColor })
    .expect(200)
}

function uploadLogo(base: string, cookie: string) {
  return request(app)
    .put(`${base}/logo`)
    .set('Cookie', cookie)
    .set('Content-Type', 'image/png')
    .send(PNG)
    .expect(200)
}

async function versions(base: string, cookie: string) {
  const res = await request(app).get(`${base}/versions`).set('Cookie', cookie).expect(200)
  return res.body.versions as Array<{
    id: string
    primaryColor: string
    accentColor: string
    logoUrl: string | null
    faviconUrl: string | null
    createdAt: string
    createdByName: string
    current: boolean
  }>
}

describe('GET /api/admin/tenants/:tenantId/branding/versions', () => {
  it('lists versions newest first with colors, images, author and current flag', async () => {
    const { base, cookie } = await setup()
    await saveColors(base, cookie, '#111111', '#222222')
    const logo = await uploadLogo(base, cookie)
    await saveColors(base, cookie, '#333333', '#444444')

    const list = await versions(base, cookie)

    expect(list).toHaveLength(3)
    expect(list.map((v) => v.primaryColor)).toEqual(['#333333', '#111111', '#111111'])
    expect(list.map((v) => v.logoUrl)).toEqual([logo.body.logoUrl, logo.body.logoUrl, null])
    expect(list.map((v) => v.current)).toEqual([true, false, false])
    expect(list[0]).toMatchObject({
      accentColor: '#444444',
      faviconUrl: null,
      createdByName: 'Test superadmin',
    })
    expect(list[0].createdAt).toBe(new Date(list[0].createdAt).toISOString())
  })

  it('returns at most 20, newest first', async () => {
    const { base, cookie } = await setup()
    for (let i = 1; i <= 22; i++) {
      await saveColors(base, cookie, `#0000${String(i).padStart(2, '0')}`, '#222222')
    }

    const list = await versions(base, cookie)

    expect(list).toHaveLength(20)
    expect(list[0].primaryColor).toBe('#000022')
    expect(list[19].primaryColor).toBe('#000003')
  })

  it('leaves out another contractor’s versions', async () => {
    const { base, cookie } = await setup()
    const other = await createTenant('other')
    await saveColors(base, cookie, '#111111', '#222222')
    await saveColors(`/api/admin/tenants/${other.id}/branding`, cookie, '#999999', '#888888')

    const list = await versions(base, cookie)

    expect(list.map((v) => v.primaryColor)).toEqual(['#111111'])
  })

  it('is empty without versions and 404s for an unknown contractor', async () => {
    const { base, cookie } = await setup()
    const res = await request(app).get(`${base}/versions`).set('Cookie', cookie).expect(200)
    expect(res.body).toEqual({ versions: [] })

    const missing = await request(app)
      .get(`/api/admin/tenants/${randomUUID()}/branding/versions`)
      .set('Cookie', cookie)
      .expect(404)
    expect(missing.body.error).toEqual({ code: 'not_found', message: 'Contractor not found' })
  })

  it('needs a superadmin', async () => {
    const { desert, base } = await setup()
    const owner = await createUser('owner', desert.id)
    await request(app).get(`${base}/versions`).expect(401)
    await request(app)
      .get(`${base}/versions`)
      .set('Cookie', await signIn(owner.email))
      .expect(403)
  })
})

describe('POST /api/admin/tenants/:tenantId/branding/versions/:versionId/restore', () => {
  it('saves a new version with the old colors and no logo, keeping history', async () => {
    const { base, cookie } = await setup()
    await saveColors(base, cookie, '#111111', '#222222')
    await uploadLogo(base, cookie)
    await saveColors(base, cookie, '#333333', '#444444')
    const before = await versions(base, cookie)
    const target = before[2]
    expect(target).toMatchObject({ primaryColor: '#111111', logoUrl: null })

    const res = await request(app)
      .post(`${base}/versions/${target.id}/restore`)
      .set('Cookie', cookie)
      .expect(200)

    expect(res.body).toMatchObject({
      slug: 'desert',
      primaryColor: '#111111',
      accentColor: '#222222',
      logoUrl: null,
      faviconUrl: null,
    })
    const after = await versions(base, cookie)
    expect(after).toHaveLength(before.length + 1)
    expect(after[0]).toMatchObject({
      primaryColor: '#111111',
      accentColor: '#222222',
      logoUrl: null,
      faviconUrl: null,
      current: true,
    })
    expect(after[0].id).not.toBe(target.id)
    expect(after.find((v) => v.id === target.id)).toEqual({ ...target, current: false })
  })

  it('brings a removed logo back', async () => {
    const { base, cookie } = await setup()
    const logo = await uploadLogo(base, cookie)
    const l1 = (await versions(base, cookie))[0]
    const removed = await request(app).delete(`${base}/logo`).set('Cookie', cookie).expect(200)
    expect(removed.body.logoUrl).toBeNull()

    const res = await request(app)
      .post(`${base}/versions/${l1.id}/restore`)
      .set('Cookie', cookie)
      .expect(200)

    expect(res.body.logoUrl).toBe(logo.body.logoUrl)
  })

  it('writes a branding.restored audit event', async () => {
    const { desert, admin, base, cookie } = await setup()
    await saveColors(base, cookie, '#111111', '#222222')
    const [first] = await versions(base, cookie)

    await request(app)
      .post(`${base}/versions/${first.id}/restore`)
      .set('Cookie', cookie)
      .expect(200)

    const [event] = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, desert.id), eq(auditEvents.action, 'branding.restored')))
    expect(event).toMatchObject({
      actorUserId: admin.id,
      entityType: 'tenant',
      entityId: desert.id,
    })
    expect(event.data).toEqual({ versionId: first.id })
  })

  it('404s for another contractor’s version, an unknown one and an unknown contractor', async () => {
    const { base, cookie } = await setup()
    const other = await createTenant('other')
    const otherBase = `/api/admin/tenants/${other.id}/branding`
    await saveColors(otherBase, cookie, '#999999', '#888888')
    const [theirs] = await versions(otherBase, cookie)
    const notFound = { code: 'not_found', message: 'Branding version not found' }

    const cross = await request(app)
      .post(`${base}/versions/${theirs.id}/restore`)
      .set('Cookie', cookie)
      .expect(404)
    expect(cross.body.error).toEqual(notFound)
    const random = await request(app)
      .post(`${base}/versions/${randomUUID()}/restore`)
      .set('Cookie', cookie)
      .expect(404)
    expect(random.body.error).toEqual(notFound)
    const noTenant = await request(app)
      .post(`/api/admin/tenants/${randomUUID()}/branding/versions/${theirs.id}/restore`)
      .set('Cookie', cookie)
      .expect(404)
    expect(noTenant.body.error).toEqual({ code: 'not_found', message: 'Contractor not found' })
    expect(await versions(base, cookie)).toEqual([])
  })

  it('400s for a malformed version id', async () => {
    const { base, cookie } = await setup()
    const res = await request(app)
      .post(`${base}/versions/not-a-uuid/restore`)
      .set('Cookie', cookie)
      .expect(400)
    expect(res.body.error.code).toBe('validation_failed')
  })

  it('needs a superadmin', async () => {
    const { desert, base } = await setup()
    const owner = await createUser('owner', desert.id)
    const url = `${base}/versions/${randomUUID()}/restore`
    await request(app).post(url).expect(401)
    await request(app)
      .post(url)
      .set('Cookie', await signIn(owner.email))
      .expect(403)
  })
})
