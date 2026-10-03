import { and, eq } from 'drizzle-orm'
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'
import { createTenant, createUser, resetDb, signIn } from '../../../test/helpers.ts'
import { createApp } from '../../app.ts'
import { db } from '../../db/client.ts'
import { auditEvents, sessions, tenants, users } from '../../db/schema.ts'
import * as accounts from '../accounts/accounts.service.ts'
import { generateTemporaryPassword } from './tenants.service.ts'

const app = createApp()

beforeEach(resetDb)

async function signedInAdmin() {
  const admin = await createUser('superadmin', null)
  return { admin, cookie: await signIn(admin.email) }
}

function newContractor() {
  return {
    name: 'Cool Breeze HVAC',
    slug: 'coolbreeze',
    timezone: 'America/Denver',
    contactEmail: 'Office@CoolBreeze.test',
    contactPhone: '(303) 555-0142',
    owner: { name: 'Casey Owner', email: '  Casey@CoolBreeze.test ' },
  }
}

describe('GET /api/admin/tenants', () => {
  it('lists contractors by name with their status and contact details', async () => {
    await createTenant('other')
    await createTenant('desert')
    const { cookie } = await signedInAdmin()

    const res = await request(app).get('/api/admin/tenants').set('Cookie', cookie).expect(200)

    expect(res.body.tenants.map((t: { slug: string }) => t.slug)).toEqual(['desert', 'other'])
    expect(res.body.tenants[0]).toEqual({
      id: expect.any(String),
      slug: 'desert',
      name: 'desert HVAC',
      status: 'setup',
      contactEmail: 'office@desert.test',
      contactPhone: '+14805550100',
      createdAt: expect.any(String),
    })
  })

  it('needs a signed-in superadmin', async () => {
    const desert = await createTenant('desert')
    const owner = await createUser('owner', desert.id)

    await request(app).get('/api/admin/tenants').expect(401)
    await request(app)
      .get('/api/admin/tenants')
      .set('Cookie', await signIn(owner.email))
      .expect(403)
  })
})

describe('POST /api/admin/tenants', () => {
  it('creates a contractor in setup and an owner who can sign in right away', async () => {
    const { cookie } = await signedInAdmin()

    const res = await request(app)
      .post('/api/admin/tenants')
      .set('Cookie', cookie)
      .send(newContractor())
      .expect(201)

    expect(res.body.tenant).toMatchObject({
      slug: 'coolbreeze',
      name: 'Cool Breeze HVAC',
      status: 'setup',
      contactEmail: 'office@coolbreeze.test',
      contactPhone: '+13035550142',
    })
    expect(res.body.owner).toMatchObject({ name: 'Casey Owner', email: 'casey@coolbreeze.test' })
    const session = await accounts.signIn('casey@coolbreeze.test', res.body.owner.temporaryPassword)
    expect(session.user).toMatchObject({ role: 'owner', tenantId: res.body.tenant.id })
  })

  it('records who created it, without the password', async () => {
    const { admin, cookie } = await signedInAdmin()

    const res = await request(app)
      .post('/api/admin/tenants')
      .set('Cookie', cookie)
      .send(newContractor())
      .expect(201)

    const events = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.tenantId, res.body.tenant.id))
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      actorType: 'user',
      actorUserId: admin.id,
      action: 'tenant.created',
      entityType: 'tenant',
      entityId: res.body.tenant.id,
      data: { slug: 'coolbreeze', ownerUserId: res.body.owner.id },
    })
    expect(JSON.stringify(events)).not.toContain(res.body.owner.temporaryPassword)
  })

  it('answers 409 slug_taken for a taken address, whatever its capitals', async () => {
    await createTenant('coolbreeze')
    const { cookie } = await signedInAdmin()

    const res = await request(app)
      .post('/api/admin/tenants')
      .set('Cookie', cookie)
      .send({ ...newContractor(), slug: 'CoolBreeze' })
      .expect(409)

    expect(res.body.error).toEqual({
      code: 'slug_taken',
      message: 'That address is taken. Pick another.',
    })
  })

  it('answers 409 email_taken and leaves no contractor behind', async () => {
    const desert = await createTenant('desert')
    const existing = await createUser('owner', desert.id)
    const { cookie } = await signedInAdmin()

    const res = await request(app)
      .post('/api/admin/tenants')
      .set('Cookie', cookie)
      .send({ ...newContractor(), owner: { name: 'Casey Owner', email: existing.email } })
      .expect(409)

    expect(res.body.error.code).toBe('email_taken')
    const left = await db.select().from(tenants).where(eq(tenants.slug, 'coolbreeze'))
    expect(left).toEqual([])
  })

  it.each([
    ['a reserved address', { slug: 'app' }, 'slug'],
    ['an address ending in a dash', { slug: 'cool-' }, 'slug'],
    ['an unknown time zone', { timezone: 'Mars/Base' }, 'timezone'],
    ['a bad phone number', { contactPhone: '555' }, 'contactPhone'],
    ['a missing owner email', { owner: { name: 'Casey Owner', email: '' } }, 'owner.email'],
  ])('rejects %s with a field error', async (_label, change, field) => {
    const { cookie } = await signedInAdmin()

    const res = await request(app)
      .post('/api/admin/tenants')
      .set('Cookie', cookie)
      .send({ ...newContractor(), ...change })
      .expect(400)

    expect(res.body.error.code).toBe('validation_failed')
    expect(Object.keys(res.body.error.details)).toEqual([field])
  })

  it('needs a signed-in superadmin', async () => {
    const desert = await createTenant('desert')
    const owner = await createUser('owner', desert.id)

    await request(app).post('/api/admin/tenants').send(newContractor()).expect(401)
    await request(app)
      .post('/api/admin/tenants')
      .set('Cookie', await signIn(owner.email))
      .send(newContractor())
      .expect(403)
  })
})

describe('generateTemporaryPassword', () => {
  it('makes 12 characters without look-alikes, different each time', () => {
    const passwords = Array.from({ length: 50 }, generateTemporaryPassword)
    for (const password of passwords) {
      expect(password).toMatch(/^[a-km-zA-HJ-NP-Z2-9]{12}$/)
    }
    expect(new Set(passwords).size).toBe(50)
  })
})

describe('PATCH /api/admin/tenants/:tenantId/status', () => {
  async function sessionCount(tenantId: string) {
    const rows = await db
      .select({ id: sessions.id })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(eq(users.tenantId, tenantId))
    return rows.length
  }

  async function statusEvents(tenantId: string) {
    return db
      .select({ data: auditEvents.data })
      .from(auditEvents)
      .where(
        and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.action, 'tenant.status_changed')),
      )
  }

  it('moves a contractor between statuses and records each change', async () => {
    const desert = await createTenant('desert')
    const { cookie } = await signedInAdmin()
    const url = `/api/admin/tenants/${desert.id}/status`

    const live = await request(app)
      .patch(url)
      .set('Cookie', cookie)
      .send({ status: 'live' })
      .expect(200)
    expect(live.body.tenant).toMatchObject({ id: desert.id, status: 'live' })

    await request(app).patch(url).set('Cookie', cookie).send({ status: 'suspended' }).expect(200)
    await request(app).patch(url).set('Cookie', cookie).send({ status: 'live' }).expect(200)

    expect((await statusEvents(desert.id)).map((e) => e.data)).toEqual([
      { from: 'setup', to: 'live' },
      { from: 'live', to: 'suspended' },
      { from: 'suspended', to: 'live' },
    ])
  })

  it('signs out everyone at a suspended contractor, and nobody else', async () => {
    const desert = await createTenant('desert')
    const other = await createTenant('other')
    const desertOwner = await createUser('owner', desert.id)
    const desertOffice = await createUser('office', desert.id)
    const otherOwner = await createUser('owner', other.id)
    await signIn(desertOwner.email)
    await signIn(desertOffice.email)
    await signIn(otherOwner.email)
    const { cookie } = await signedInAdmin()

    await request(app)
      .patch(`/api/admin/tenants/${desert.id}/status`)
      .set('Cookie', cookie)
      .send({ status: 'suspended' })
      .expect(200)

    expect(await sessionCount(desert.id)).toBe(0)
    expect(await sessionCount(other.id)).toBe(1)
    await request(app).get('/api/admin/tenants').set('Cookie', cookie).expect(200)
  })

  it('records nothing when the status is already set', async () => {
    const desert = await createTenant('desert')
    const { cookie } = await signedInAdmin()
    const url = `/api/admin/tenants/${desert.id}/status`

    await request(app).patch(url).set('Cookie', cookie).send({ status: 'live' }).expect(200)
    await request(app).patch(url).set('Cookie', cookie).send({ status: 'live' }).expect(200)

    expect(await statusEvents(desert.id)).toHaveLength(1)
  })

  it('404s for an unknown contractor and rejects an unknown status', async () => {
    const desert = await createTenant('desert')
    const { cookie } = await signedInAdmin()

    await request(app)
      .patch('/api/admin/tenants/00000000-0000-4000-8000-000000000000/status')
      .set('Cookie', cookie)
      .send({ status: 'live' })
      .expect(404)
    const bad = await request(app)
      .patch(`/api/admin/tenants/${desert.id}/status`)
      .set('Cookie', cookie)
      .send({ status: 'deleted' })
      .expect(400)
    expect(Object.keys(bad.body.error.details)).toEqual(['status'])
  })

  it('needs a signed-in superadmin', async () => {
    const desert = await createTenant('desert')
    const owner = await createUser('owner', desert.id)

    await request(app)
      .patch(`/api/admin/tenants/${desert.id}/status`)
      .set('Cookie', await signIn(owner.email))
      .send({ status: 'suspended' })
      .expect(403)
  })
})
