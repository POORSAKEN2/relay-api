import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createShop, createTenant, createUser, resetDb, signIn } from '../../../test/helpers.ts'
import { createApp } from '../../app.ts'
import { env } from '../../config/env.ts'
import { db } from '../../db/client.ts'
import { tenants } from '../../db/schema.ts'

const app = createApp()
const AUTH = 'test-revenuecat-webhook-auth'
const DAY = 86_400_000

beforeEach(async () => {
  await resetDb()
  env.REVENUECAT_WEBHOOK_AUTH = AUTH
})
afterEach(() => {
  env.REVENUECAT_WEBHOOK_AUTH = undefined
})

function event(tenantId: string, type: string, extra: object = {}) {
  return {
    api_version: '1.0',
    event: {
      id: randomUUID(),
      type,
      app_user_id: tenantId,
      environment: 'SANDBOX',
      event_timestamp_ms: Date.now(),
      expiration_at_ms: Date.now() + 30 * DAY,
      ...extra,
    },
  }
}

function post(body: object, authorization: string | null = AUTH) {
  const req = request(app).post('/api/webhooks/revenuecat')
  return (authorization ? req.set('Authorization', authorization) : req).send(body)
}

async function subscriptionOf(tenantId: string) {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId))
  return tenant
}

describe('POST /api/webhooks/revenuecat', () => {
  it('refuses a missing or wrong authorization', async () => {
    const tenant = await createTenant('desert')
    const body = event(tenant.id, 'INITIAL_PURCHASE')

    await post(body, null).expect(401)
    await post(body, 'wrong').expect(401)
    expect((await subscriptionOf(tenant.id)).subscriptionStatus).toBe('none')
  })

  it('refuses everything when no authorization is configured', async () => {
    env.REVENUECAT_WEBHOOK_AUTH = undefined
    const tenant = await createTenant('desert')

    await post(event(tenant.id, 'INITIAL_PURCHASE'), '').expect(401)
  })

  it('activates the contractor on a purchase and keeps the expiry', async () => {
    const tenant = await createTenant('desert')
    const body = event(tenant.id, 'INITIAL_PURCHASE')

    await post(body).expect(200)

    const saved = await subscriptionOf(tenant.id)
    expect(saved.subscriptionStatus).toBe('active')
    expect(saved.subscriptionExpiresAt?.getTime()).toBe(body.event.expiration_at_ms)
  })

  it('follows a billing problem, then an expiry', async () => {
    const tenant = await createTenant('desert')
    const now = Date.now()
    await post(event(tenant.id, 'INITIAL_PURCHASE', { event_timestamp_ms: now })).expect(200)

    await post(event(tenant.id, 'BILLING_ISSUE', { event_timestamp_ms: now + 1 })).expect(200)
    expect((await subscriptionOf(tenant.id)).subscriptionStatus).toBe('billing_issue')

    await post(event(tenant.id, 'EXPIRATION', { event_timestamp_ms: now + 2 })).expect(200)
    expect((await subscriptionOf(tenant.id)).subscriptionStatus).toBe('expired')
  })

  it('ignores a late event that arrives after a newer one', async () => {
    const tenant = await createTenant('desert')
    const now = Date.now()
    await post(event(tenant.id, 'EXPIRATION', { event_timestamp_ms: now })).expect(200)

    await post(event(tenant.id, 'BILLING_ISSUE', { event_timestamp_ms: now - 5000 })).expect(200)

    expect((await subscriptionOf(tenant.id)).subscriptionStatus).toBe('expired')
  })

  it('handles a repeated event once', async () => {
    const tenant = await createTenant('desert')
    const purchase = event(tenant.id, 'INITIAL_PURCHASE')
    await post(purchase).expect(200)
    await db.update(tenants).set({ subscriptionStatus: 'expired' }).where(eq(tenants.id, tenant.id))

    await post(purchase).expect(200)

    expect((await subscriptionOf(tenant.id)).subscriptionStatus).toBe('expired')
  })

  it('keeps access after a cancellation, until the period ends', async () => {
    const tenant = await createTenant('desert')
    await post(event(tenant.id, 'INITIAL_PURCHASE', { event_timestamp_ms: 1000 })).expect(200)

    await post(event(tenant.id, 'CANCELLATION', { event_timestamp_ms: 2000 })).expect(200)

    expect((await subscriptionOf(tenant.id)).subscriptionStatus).toBe('active')
  })

  it('ignores production events outside production', async () => {
    const tenant = await createTenant('desert')

    await post(event(tenant.id, 'INITIAL_PURCHASE', { environment: 'PRODUCTION' })).expect(200)

    expect((await subscriptionOf(tenant.id)).subscriptionStatus).toBe('none')
  })

  it('ignores a user that is not a contractor, and answers 200', async () => {
    await post(event('$RCAnonymousID:abc', 'INITIAL_PURCHASE')).expect(200)
    await post(event(randomUUID(), 'INITIAL_PURCHASE')).expect(200)
  })

  it('answers 200 to the test event from the RevenueCat dashboard', async () => {
    await post(event('anyone', 'TEST')).expect(200)
  })
})

describe('GET /api/billing', () => {
  it('gives the owner the subscription and the id RevenueCat knows them by', async () => {
    const tenant = await createTenant('desert')
    const owner = await createUser('owner', tenant.id)
    const cookie = await signIn(owner.email)

    const res = await request(app).get('/api/billing').set('Cookie', cookie).expect(200)

    expect(res.body).toEqual({ tenantId: tenant.id, status: 'none', expiresAt: null })
  })

  it('needs a signed-in owner', async () => {
    await request(app).get('/api/billing').expect(401)
    const shop = await createShop('desert')
    await request(app).get('/api/billing').set('Cookie', shop.cookie).expect(403) // office
  })
})
