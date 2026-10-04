import { and, eq, isNull } from 'drizzle-orm'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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
import { auditEvents, sessions, signInLinks, users } from '../../db/schema.ts'
import { sendEmail } from '../../lib/email.ts'
import { emitToTenant } from '../../realtime/index.ts'

vi.mock('../../realtime/index.ts', () => ({ emitToTenant: vi.fn() }))
vi.mock('../../lib/email.ts', () => ({ sendEmail: vi.fn() }))

const app = createApp()

beforeEach(async () => {
  await resetDb()
  vi.mocked(emitToTenant).mockClear()
  vi.mocked(sendEmail).mockReset()
})

// The shop's office user plus an owner, each with a session.
async function shopWithOwner() {
  const shop = await createShop('desert')
  const owner = await createUser('owner', shop.tenant.id)
  return { shop, owner, ownerCookie: await signIn(owner.email) }
}

function invite(cookie: string, body: Record<string, unknown>) {
  return request(app).post('/api/staff').set('Cookie', cookie).send(body)
}

// The token in the link of the last email sent.
function emailedToken(): string {
  const { text } = vi.mocked(sendEmail).mock.calls.at(-1)![0]
  return text.match(/token=([\w-]+)/)![1]
}

describe('GET /api/staff', () => {
  it("lists the contractor's owners and office users, not technicians or other contractors", async () => {
    const { shop, owner } = await shopWithOwner()
    const other = await createTenant('other')
    await createUser('office', other.id)

    const res = await request(app).get('/api/staff').set('Cookie', shop.cookie).expect(200)

    expect(res.body.staff.map((p: { id: string }) => p.id).sort()).toEqual(
      [shop.office.id, owner.id].sort(),
    )
    expect(res.body.staff[0]).toEqual({
      id: expect.any(String),
      name: expect.any(String),
      email: expect.any(String),
      role: expect.stringMatching(/owner|office/),
      active: true,
      invited: false,
    })
  })

  it('is closed to technicians and signed-out visitors', async () => {
    await request(app).get('/api/staff').expect(401)
    const shop = await createShop('desert')
    const cookie = await signInTechnician(shop.mike)
    await request(app).get('/api/staff').set('Cookie', cookie).expect(403)
  })
})

describe('POST /api/staff', () => {
  it('creates the user, emails a one-time link and records it', async () => {
    const { owner, ownerCookie } = await shopWithOwner()

    const res = await invite(ownerCookie, {
      name: 'Dana Torres',
      email: 'Dana@Desert.test',
      role: 'office',
    }).expect(201)

    expect(res.body).toEqual({
      emailSent: true,
      person: {
        id: expect.any(String),
        name: 'Dana Torres',
        email: 'dana@desert.test',
        role: 'office',
        active: true,
        invited: true,
      },
    })
    expect(sendEmail).toHaveBeenCalledTimes(1)
    expect(vi.mocked(sendEmail).mock.calls[0][0]).toMatchObject({
      to: 'dana@desert.test',
      text: expect.stringContaining('https://desert.localhost/sign-in/link?token='),
    })
    const [saved] = await db.select().from(users).where(eq(users.id, res.body.person.id))
    expect(saved).toMatchObject({ tenantId: owner.tenantId, passwordHash: null })
    const [event] = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.entityId, res.body.person.id))
    expect(event).toMatchObject({
      action: 'user.created',
      actorUserId: owner.id,
      data: { role: 'office' },
    })
    expect(emitToTenant).toHaveBeenCalledWith(owner.tenantId, 'team.updated', {
      tenantId: owner.tenantId,
    })
  })

  it('keeps the user and says so when the email fails', async () => {
    const { ownerCookie } = await shopWithOwner()
    vi.mocked(sendEmail).mockRejectedValue(new Error('smtp down'))

    const res = await invite(ownerCookie, {
      name: 'Dana',
      email: 'dana@desert.test',
      role: 'office',
    }).expect(201)

    expect(res.body.emailSent).toBe(false)
    expect(res.body.person.invited).toBe(true)
  })

  it('refuses an email another account already uses', async () => {
    const { shop, ownerCookie } = await shopWithOwner()

    const res = await invite(ownerCookie, {
      name: 'Dup',
      email: shop.office.email,
      role: 'office',
    }).expect(409)

    expect(res.body.error.code).toBe('email_taken')
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('lets only an owner invite an owner', async () => {
    const { shop, ownerCookie } = await shopWithOwner()
    const body = { name: 'Boss', email: 'boss@desert.test', role: 'owner' }

    const res = await invite(shop.cookie, body).expect(403)
    expect(res.body.error.code).toBe('forbidden')

    await invite(ownerCookie, body).expect(201)
  })

  it('rejects a bad body with field errors', async () => {
    const { ownerCookie } = await shopWithOwner()
    const res = await invite(ownerCookie, { name: '', email: 'nope', role: 'technician' }).expect(
      400,
    )
    expect(Object.keys(res.body.error.details).sort()).toEqual(['email', 'name', 'role'])
  })
})

describe('POST /api/auth/link/sign-in', () => {
  async function invited() {
    const ctx = await shopWithOwner()
    const res = await invite(ctx.ownerCookie, {
      name: 'Dana',
      email: 'dana@desert.test',
      role: 'office',
    })
    return { ...ctx, personId: res.body.person.id as string, token: emailedToken() }
  }

  it('signs the invited user in once, and they stop showing as invited', async () => {
    const { ownerCookie, personId, token } = await invited()

    const res = await request(app).post('/api/auth/link/sign-in').send({ token }).expect(200)

    expect(res.body.user).toMatchObject({ id: personId, role: 'office' })
    expect(res.get('Set-Cookie')?.[0]).toMatch(/^relay_session=[\w-]+;.*HttpOnly/)
    const list = await request(app).get('/api/staff').set('Cookie', ownerCookie)
    expect(list.body.staff.find((p: { id: string }) => p.id === personId).invited).toBe(false)

    await request(app).post('/api/auth/link/sign-in').send({ token }).expect(401)
  })

  it('refuses unknown and expired links the same way', async () => {
    const { token } = await invited()
    await db.update(signInLinks).set({ expiresAt: new Date(Date.now() - 1000) })

    const expired = await request(app).post('/api/auth/link/sign-in').send({ token }).expect(401)
    const unknown = await request(app)
      .post('/api/auth/link/sign-in')
      .send({ token: 'nope' })
      .expect(401)

    expect(expired.body).toEqual(unknown.body)
  })

  it('stores only a hash of the token', async () => {
    const { token } = await invited()
    const links = await db.select().from(signInLinks)
    expect(links).toHaveLength(1)
    expect(links[0].tokenHash).not.toContain(token)
  })

  it('refuses a deactivated user', async () => {
    const { ownerCookie, personId } = await invited()
    await request(app).post(`/api/staff/${personId}/link`).set('Cookie', ownerCookie).expect(200)
    const token = emailedToken()
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, personId))

    await request(app).post('/api/auth/link/sign-in').send({ token }).expect(401)
  })
})

describe('POST /api/staff/:id/link', () => {
  it('emails a new link and voids the old one', async () => {
    const { ownerCookie } = await shopWithOwner()
    const created = await invite(ownerCookie, {
      name: 'Dana',
      email: 'dana@desert.test',
      role: 'office',
    })
    const oldToken = emailedToken()

    await request(app)
      .post(`/api/staff/${created.body.person.id}/link`)
      .set('Cookie', ownerCookie)
      .expect(200)
    const newToken = emailedToken()

    expect(newToken).not.toBe(oldToken)
    await request(app).post('/api/auth/link/sign-in').send({ token: oldToken }).expect(401)
    await request(app).post('/api/auth/link/sign-in').send({ token: newToken }).expect(200)
  })

  it('says so when the email fails, and refuses a deactivated user', async () => {
    const { shop, ownerCookie } = await shopWithOwner()
    vi.mocked(sendEmail).mockRejectedValue(new Error('smtp down'))
    const failed = await request(app)
      .post(`/api/staff/${shop.office.id}/link`)
      .set('Cookie', ownerCookie)
      .expect(502)
    expect(failed.body.error.code).toBe('email_failed')

    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, shop.office.id))
    const res = await request(app)
      .post(`/api/staff/${shop.office.id}/link`)
      .set('Cookie', ownerCookie)
      .expect(409)
    expect(res.body.error.code).toBe('deactivated')
  })
})

describe('PATCH /api/staff/:id', () => {
  it('edits name, email and role, and voids a link sent to the old email', async () => {
    const { ownerCookie } = await shopWithOwner()
    const created = await invite(ownerCookie, {
      name: 'Dana',
      email: 'dana@desert.test',
      role: 'office',
    })
    const id = created.body.person.id

    const res = await request(app)
      .patch(`/api/staff/${id}`)
      .set('Cookie', ownerCookie)
      .send({ name: 'Dana T', email: 'dana.t@desert.test', role: 'owner' })
      .expect(200)

    expect(res.body.person).toMatchObject({
      name: 'Dana T',
      email: 'dana.t@desert.test',
      role: 'owner',
    })
    const unused = await db
      .select()
      .from(signInLinks)
      .where(and(eq(signInLinks.userId, id), isNull(signInLinks.usedAt)))
    expect(unused).toHaveLength(0)
  })

  it('keeps office users from touching owners or promoting anyone', async () => {
    const { shop, owner } = await shopWithOwner()
    const other = await createUser('office', shop.tenant.id)

    const editOwner = await request(app)
      .patch(`/api/staff/${owner.id}`)
      .set('Cookie', shop.cookie)
      .send({ name: 'x', email: owner.email, role: 'office' })
      .expect(403)
    expect(editOwner.body.error.code).toBe('forbidden')
    await request(app)
      .patch(`/api/staff/${other.id}`)
      .set('Cookie', shop.cookie)
      .send({ name: 'x', email: other.email, role: 'owner' })
      .expect(403)
  })

  it('refuses to change your own role', async () => {
    const { owner, ownerCookie } = await shopWithOwner()
    const res = await request(app)
      .patch(`/api/staff/${owner.id}`)
      .set('Cookie', ownerCookie)
      .send({ name: 'Me', email: owner.email, role: 'office' })
      .expect(409)
    expect(res.body.error.code).toBe('own_role')
  })

  it("won't find a technician or another contractor's user", async () => {
    const { shop, ownerCookie } = await shopWithOwner()
    const other = await createTenant('other')
    const stranger = await createUser('office', other.id)
    for (const id of [shop.mike.id, stranger.id]) {
      await request(app)
        .patch(`/api/staff/${id}`)
        .set('Cookie', ownerCookie)
        .send({ name: 'x', email: 'x@desert.test', role: 'office' })
        .expect(404)
    }
  })
})

describe('deactivate and reactivate', () => {
  it('signs the user out and blocks them until reactivated', async () => {
    const { shop, ownerCookie } = await shopWithOwner()

    const res = await request(app)
      .post(`/api/staff/${shop.office.id}/deactivate`)
      .set('Cookie', ownerCookie)
      .expect(200)

    expect(res.body.person.active).toBe(false)
    expect(await db.select().from(sessions).where(eq(sessions.userId, shop.office.id))).toEqual([])
    await request(app).get('/api/staff').set('Cookie', shop.cookie).expect(401)

    await request(app)
      .post(`/api/staff/${shop.office.id}/reactivate`)
      .set('Cookie', ownerCookie)
      .expect(200)
    const cookie = await signIn(shop.office.email)
    await request(app).get('/api/staff').set('Cookie', cookie).expect(200)
  })

  it('refuses to deactivate yourself', async () => {
    const { owner, ownerCookie } = await shopWithOwner()
    const res = await request(app)
      .post(`/api/staff/${owner.id}/deactivate`)
      .set('Cookie', ownerCookie)
      .expect(409)
    expect(res.body.error.code).toBe('own_account')
  })

  it('lets only an owner deactivate or reactivate an owner', async () => {
    const { shop, owner } = await shopWithOwner()
    await request(app)
      .post(`/api/staff/${owner.id}/deactivate`)
      .set('Cookie', shop.cookie)
      .expect(403)
    await request(app)
      .post(`/api/staff/${owner.id}/reactivate`)
      .set('Cookie', shop.cookie)
      .expect(403)
  })

  it("does not count a reactivated person's old link as an invite", async () => {
    const { ownerCookie } = await shopWithOwner()
    const created = await invite(ownerCookie, {
      name: 'Dana',
      email: 'dana@desert.test',
      role: 'office',
    })
    const id = created.body.person.id
    await request(app).post('/api/auth/link/sign-in').send({ token: emailedToken() }).expect(200)

    await request(app).post(`/api/staff/${id}/deactivate`).set('Cookie', ownerCookie).expect(200)
    const res = await request(app)
      .post(`/api/staff/${id}/reactivate`)
      .set('Cookie', ownerCookie)
      .expect(200)

    expect(res.body.person).toMatchObject({ active: true, invited: false })
  })
})
