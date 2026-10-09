import { eq } from 'drizzle-orm'
import request from 'supertest'
import { beforeEach, expect, it } from 'vitest'
import { createTenant, createUser, PASSWORD, resetDb } from '../../../test/helpers.ts'
import { createApp } from '../../app.ts'
import { db } from '../../db/client.ts'
import { sessions } from '../../db/schema.ts'
import { signIn } from './accounts.service.ts'

// Own file: the sign-in limiter allows 10 requests per 15 minutes and counts every request
// this file makes to /api/auth/*, so the role and portal pairings call the service directly.
const app = createApp()

beforeEach(resetDb)

it('lets owners and office staff in through the contractor portal', async () => {
  const tenant = await createTenant('desert')
  for (const role of ['owner', 'office'] as const) {
    const user = await createUser(role, tenant.id)
    await request(app)
      .post('/api/auth/sign-in')
      .send({ email: user.email, password: PASSWORD, portal: 'contractor' })
      .expect(200)
  }
})

it('lets the Relay admin in through the admin portal', async () => {
  const admin = await createUser('superadmin', null)
  const res = await request(app)
    .post('/api/auth/sign-in')
    .send({ email: admin.email, password: PASSWORD, portal: 'admin' })
    .expect(200)
  expect(res.body.user.role).toBe('superadmin')
})

it('refuses the Relay admin at the contractor portal without starting a session', async () => {
  const admin = await createUser('superadmin', null)

  const res = await request(app)
    .post('/api/auth/sign-in')
    .send({ email: admin.email, password: PASSWORD, portal: 'contractor' })
    .expect(403)

  expect(res.body.error).toMatchObject({
    code: 'use_admin_portal',
    message: 'This is a Relay admin account. Use the admin portal.',
  })
  expect(res.get('Set-Cookie')).toBeUndefined()
  expect(await db.select().from(sessions).where(eq(sessions.userId, admin.id))).toEqual([])
})

it.each([
  [
    'superadmin',
    'contractor',
    'use_admin_portal',
    'This is a Relay admin account. Use the admin portal.',
  ],
  [
    'owner',
    'admin',
    'use_contractor_portal',
    'This is a contractor account. Use the contractor portal.',
  ],
  [
    'office',
    'admin',
    'use_contractor_portal',
    'This is a contractor account. Use the contractor portal.',
  ],
  [
    'technician',
    'contractor',
    'use_technician_portal',
    'This is a technician account. Sign in with a text code.',
  ],
  [
    'technician',
    'admin',
    'use_technician_portal',
    'This is a technician account. Sign in with a text code.',
  ],
] as const)('refuses a %s at the %s portal', async (role, portal, code, message) => {
  const tenant = await createTenant('desert')
  const user = await createUser(role, role === 'superadmin' ? null : tenant.id)

  await expect(signIn(user.email, PASSWORD, portal)).rejects.toMatchObject({
    status: 403,
    code,
    message,
  })
  expect(await db.select().from(sessions).where(eq(sessions.userId, user.id))).toEqual([])
})

it('answers a wrong password at the wrong portal with 401, not the portal hint', async () => {
  const admin = await createUser('superadmin', null)
  const res = await request(app)
    .post('/api/auth/sign-in')
    .send({ email: admin.email, password: 'not it', portal: 'contractor' })
    .expect(401)
  expect(res.body.error.code).toBe('unauthorized')
})

it('rejects an unknown portal', async () => {
  const res = await request(app)
    .post('/api/auth/sign-in')
    .send({ email: 'a@test.local', password: 'x', portal: 'technician' })
    .expect(400)
  expect(Object.keys(res.body.error.details)).toEqual(['portal'])
})
