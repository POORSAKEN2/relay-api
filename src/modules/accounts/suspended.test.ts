import { count, eq } from 'drizzle-orm'
import request from 'supertest'
import { beforeEach, expect, it } from 'vitest'
import { createTenant, createUser, PASSWORD, resetDb, signIn } from '../../../test/helpers.ts'
import { createApp } from '../../app.ts'
import { db } from '../../db/client.ts'
import { signInCodes, tenants } from '../../db/schema.ts'
import * as accounts from './accounts.service.ts'

// The sign-in routes are rate limited, so these call the service directly; the session
// checks go through the app.

const app = createApp()

beforeEach(resetDb)

// A direct update, without the admin route: proves the checks hold even if sessions were
// not deleted.
async function setStatus(tenantId: string, status: 'live' | 'suspended') {
  await db.update(tenants).set({ status }).where(eq(tenants.id, tenantId))
}

const suspendedError = {
  status: 403,
  code: 'contractor_suspended',
  message: 'Your company’s account is turned off. Contact Relay support.',
}

it('refuses email sign-in at a turned-off contractor, but only after the password', async () => {
  const desert = await createTenant('desert')
  const owner = await createUser('owner', desert.id)
  await setStatus(desert.id, 'suspended')

  await expect(accounts.signIn(owner.email, PASSWORD, 'contractor')).rejects.toMatchObject(
    suspendedError,
  )
  await expect(accounts.signIn(owner.email, 'wrong password', 'contractor')).rejects.toMatchObject({
    status: 401,
    code: 'unauthorized',
  })
})

it('texts no sign-in code to a technician of a turned-off contractor', async () => {
  const desert = await createTenant('desert')
  const technician = await createUser('technician', desert.id)
  await setStatus(desert.id, 'suspended')

  await accounts.requestSignInCode(technician.phone!)

  const [{ codes }] = await db
    .select({ codes: count() })
    .from(signInCodes)
    .where(eq(signInCodes.userId, technician.id))
  expect(codes).toBe(0)
})

it('refuses a code sent before the contractor was turned off', async () => {
  const desert = await createTenant('desert')
  const technician = await createUser('technician', desert.id)
  await db.insert(signInCodes).values({
    userId: technician.id,
    codeHash: accounts.hashCode('123456'),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  })
  await setStatus(desert.id, 'suspended')

  await expect(accounts.signInWithCode(technician.phone!, '123456')).rejects.toMatchObject(
    suspendedError,
  )
})

it('treats sessions opened before the contractor was turned off as signed out', async () => {
  const desert = await createTenant('desert')
  const office = await createUser('office', desert.id)
  const cookie = await signIn(office.email)
  await setStatus(desert.id, 'suspended')

  const me = await request(app).get('/api/auth/me').set('Cookie', cookie).expect(200)
  expect(me.body.user).toBeNull()
  await request(app).get('/api/technicians').set('Cookie', cookie).expect(401)
})

it('lets everyone back in when the contractor is turned on again', async () => {
  const desert = await createTenant('desert')
  const owner = await createUser('owner', desert.id)
  await setStatus(desert.id, 'suspended')
  await setStatus(desert.id, 'live')

  const cookie = await signIn(owner.email)
  const me = await request(app).get('/api/auth/me').set('Cookie', cookie).expect(200)
  expect(me.body.user).toMatchObject({ id: owner.id })
})

it('never affects the superadmin', async () => {
  const desert = await createTenant('desert')
  const admin = await createUser('superadmin', null)
  const cookie = await signIn(admin.email)
  await setStatus(desert.id, 'suspended')

  const me = await request(app).get('/api/auth/me').set('Cookie', cookie).expect(200)
  expect(me.body.user).toMatchObject({ id: admin.id, role: 'superadmin' })
  await expect(accounts.signIn(admin.email, PASSWORD, 'admin')).resolves.toBeTruthy()
})
