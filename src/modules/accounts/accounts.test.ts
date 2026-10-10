import { eq } from 'drizzle-orm'
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'
import { createTenant, createUser, PASSWORD, resetDb, signIn } from '../../../test/helpers.ts'
import { createApp } from '../../app.ts'
import { db } from '../../db/client.ts'
import { sessions, users } from '../../db/schema.ts'
import { cleanupExpiredSessions } from './accounts.service.ts'

const DAY_MS = 24 * 60 * 60 * 1000
const app = createApp()

beforeEach(resetDb)

describe('POST /api/auth/sign-in', () => {
  it('sets an httpOnly session cookie and returns the user', async () => {
    const tenant = await createTenant('desert')
    const owner = await createUser('owner', tenant.id)

    const res = await request(app)
      .post('/api/auth/sign-in')
      .send({ email: owner.email.toUpperCase(), password: PASSWORD, portal: 'contractor' })
      .expect(200)

    expect(res.body.user).toMatchObject({ id: owner.id, role: 'owner', tenantId: tenant.id })
    const [cookie] = res.get('Set-Cookie') ?? []
    expect(cookie).toMatch(/^relay_session=[\w-]+;/)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
  })

  it('gives the same answer for a wrong password and an unknown email', async () => {
    const tenant = await createTenant('desert')
    const owner = await createUser('owner', tenant.id)

    const wrongPassword = await request(app)
      .post('/api/auth/sign-in')
      .send({ email: owner.email, password: 'not it', portal: 'contractor' })
      .expect(401)
    const unknownEmail = await request(app)
      .post('/api/auth/sign-in')
      .send({ email: 'nobody@test.local', password: PASSWORD, portal: 'contractor' })
      .expect(401)

    expect(wrongPassword.body).toEqual(unknownEmail.body)
    expect(wrongPassword.body.error.code).toBe('unauthorized')
  })

  it('rejects a malformed body with field errors', async () => {
    const res = await request(app)
      .post('/api/auth/sign-in')
      .send({ email: 'not-an-email' })
      .expect(400)
    expect(res.body.error.code).toBe('validation_failed')
    expect(Object.keys(res.body.error.details).sort()).toEqual(['email', 'password', 'portal'])
  })
})

describe('GET /api/auth/me and POST /api/auth/sign-out', () => {
  it('returns null when signed out', async () => {
    const res = await request(app).get('/api/auth/me').expect(200)
    expect(res.body).toEqual({ user: null })
  })

  it('returns the user until sign-out', async () => {
    const tenant = await createTenant('desert')
    const owner = await createUser('owner', tenant.id)
    const cookie = await signIn(owner.email)

    const me = await request(app).get('/api/auth/me').set('Cookie', cookie).expect(200)
    expect(me.body.user).toMatchObject({ id: owner.id, email: owner.email })

    const signOut = await request(app).post('/api/auth/sign-out').set('Cookie', cookie).expect(204)
    expect(signOut.get('Set-Cookie')?.[0]).toMatch(/^relay_session=;/)

    const after = await request(app).get('/api/auth/me').set('Cookie', cookie).expect(200)
    expect(after.body).toEqual({ user: null })
  })

  it('signs out without a session too', async () => {
    await request(app).post('/api/auth/sign-out').expect(204)
  })
})

describe('sessions', () => {
  it('extends a session with under 15 days left and sends the cookie again', async () => {
    const tenant = await createTenant('desert')
    const owner = await createUser('owner', tenant.id)
    const cookie = await signIn(owner.email)
    await db.update(sessions).set({ expiresAt: new Date(Date.now() + 10 * DAY_MS) })

    const res = await request(app).get('/api/auth/me').set('Cookie', cookie).expect(200)

    expect(res.get('Set-Cookie')?.[0]).toMatch(/^relay_session=/)
    const [session] = await db.select().from(sessions)
    expect(session.expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * DAY_MS)
  })

  it('treats an expired session as signed out', async () => {
    const tenant = await createTenant('desert')
    const owner = await createUser('owner', tenant.id)
    const cookie = await signIn(owner.email)
    await db.update(sessions).set({ expiresAt: new Date(Date.now() - 1000) })

    const res = await request(app).get('/api/auth/me').set('Cookie', cookie).expect(200)
    expect(res.body).toEqual({ user: null })
  })

  it('treats the session of a deactivated user as signed out', async () => {
    const tenant = await createTenant('desert')
    const owner = await createUser('owner', tenant.id)
    const cookie = await signIn(owner.email)
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, owner.id))

    const res = await request(app).get('/api/auth/me').set('Cookie', cookie).expect(200)
    expect(res.body).toEqual({ user: null })
  })

  it('cleanup deletes expired sessions only', async () => {
    const tenant = await createTenant('desert')
    const owner = await createUser('owner', tenant.id)
    const office = await createUser('office', tenant.id)
    await signIn(owner.email)
    await signIn(office.email)
    await db.update(sessions).set({ expiresAt: new Date(Date.now() - 1000) })
    await signIn(owner.email)

    expect(await cleanupExpiredSessions()).toBe(2)
    expect(await db.select().from(sessions)).toHaveLength(1)
  })
})
