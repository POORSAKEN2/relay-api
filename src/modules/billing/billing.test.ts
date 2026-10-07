import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createJob,
  createShop,
  createTenant,
  createUser,
  resetDb,
  type Shop,
  signIn,
} from '../../../test/helpers.ts'
import { createApp } from '../../app.ts'
import { env } from '../../config/env.ts'
import { db } from '../../db/client.ts'
import { auditEvents, subscriptionInvoices, tenants } from '../../db/schema.ts'
import { createMonthlyInvoices } from './billing.service.ts'

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

describe('createMonthlyInvoices', () => {
  // 12:00 UTC on 1 October is 05:00 in Phoenix (UTC-7): September has ended there.
  const OCTOBER_1 = new Date('2026-10-01T12:00:00Z')
  const phoenix = (local: string) => new Date(`${local}-07:00`)

  async function shopWithFee(perJobFeeCents: number) {
    const shop = await createShop('desert')
    await db.update(tenants).set({ perJobFeeCents }).where(eq(tenants.id, shop.tenant.id))
    return shop
  }

  async function invoicesOf(tenantId: string) {
    return db.select().from(subscriptionInvoices).where(eq(subscriptionInvoices.tenantId, tenantId))
  }

  it('bills the recovered jobs booked last month in the contractor’s time zone', async () => {
    const shop = await shopWithFee(1500)
    // Counted: recovered sources, booked in Phoenix's September.
    await createJob(shop, { source: 'text_back', bookedAt: phoenix('2026-09-10T09:00') })
    await createJob(shop, { source: 'ai', bookedAt: phoenix('2026-09-30T23:00') }) // October in UTC
    await createJob(shop, {
      source: 'recovery_text',
      status: 'done',
      technicianId: shop.mike.id,
      bookedAt: phoenix('2026-09-01T00:00'),
    })
    // Not counted.
    await createJob(shop, { source: 'recovery_text', bookedAt: phoenix('2026-10-01T00:30') })
    await createJob(shop, { source: 'recovery_text', bookedAt: phoenix('2026-08-31T23:30') })
    await createJob(shop, { source: 'web', bookedAt: phoenix('2026-09-10T09:00') })
    await createJob(shop, {
      source: 'text_back',
      status: 'cancelled',
      bookedAt: phoenix('2026-09-10T09:00'),
    })
    await createJob(shop, {
      source: 'ai',
      status: 'held',
      holdExpiresAt: phoenix('2026-09-10T09:15'),
      bookedAt: null,
    })

    expect(await createMonthlyInvoices(OCTOBER_1)).toBe(1)

    const [invoice] = await invoicesOf(shop.tenant.id)
    expect(invoice).toMatchObject({
      periodStart: '2026-09-01',
      periodEnd: '2026-10-01',
      monthlyFeeCents: 0,
      recoveredJobs: 3,
      perJobFeeCents: 1500,
      totalCents: 4500,
      status: 'open',
      paidAt: null,
    })
  })

  it('makes each month’s invoice once, and keeps its fee when the fee changes', async () => {
    const shop = await shopWithFee(1500)
    await createJob(shop, { source: 'ai', bookedAt: phoenix('2026-09-10T09:00') })
    await createMonthlyInvoices(OCTOBER_1)
    await db.update(tenants).set({ perJobFeeCents: 9900 }).where(eq(tenants.id, shop.tenant.id))

    expect(await createMonthlyInvoices(new Date('2026-10-02T12:00:00Z'))).toBe(0)

    const invoices = await invoicesOf(shop.tenant.id)
    expect(invoices).toHaveLength(1)
    expect(invoices[0].totalCents).toBe(1500)
  })

  it('waits until the month has ended in the contractor’s time zone', async () => {
    const shop = await shopWithFee(1500)
    await createJob(shop, { source: 'ai', bookedAt: phoenix('2026-09-10T09:00') })

    // 05:00 UTC on 1 October is still 30 September in Phoenix.
    expect(await createMonthlyInvoices(new Date('2026-10-01T05:00:00Z'))).toBe(0)
    expect(await invoicesOf(shop.tenant.id)).toEqual([])
  })

  it('makes no invoice without a fee or without recovered jobs', async () => {
    const shop = await shopWithFee(0)
    await createJob(shop, { source: 'ai', bookedAt: phoenix('2026-09-10T09:00') })
    const other = await createTenant('cool')
    await db.update(tenants).set({ perJobFeeCents: 1500 }).where(eq(tenants.id, other.id))

    expect(await createMonthlyInvoices(OCTOBER_1)).toBe(0)
  })
})

describe('recovered-job invoices over HTTP', () => {
  async function setUp() {
    const shop = await createShop('desert')
    const owner = await createUser('owner', shop.tenant.id)
    const admin = await createUser('superadmin', null)
    return { shop, owner: await signIn(owner.email), admin: await signIn(admin.email) }
  }

  async function invoiceFor(shop: Shop) {
    await createJob(shop, { source: 'ai', bookedAt: new Date('2026-09-10T16:00:00Z') })
    await createMonthlyInvoices(new Date('2026-10-01T12:00:00Z'))
    const [invoice] = await db.select().from(subscriptionInvoices)
    return invoice
  }

  it('lets the superadmin set the fee, then mark the invoice paid; the owner sees it', async () => {
    const { shop, owner, admin } = await setUp()
    const fee = `/api/admin/tenants/${shop.tenant.id}/per-job-fee`

    await request(app).put(fee).set('Cookie', admin).send({ perJobFeeCents: 2500 }).expect(200)
    const invoice = await invoiceFor(shop)

    const billing = await request(app)
      .get(`/api/admin/tenants/${shop.tenant.id}/billing`)
      .set('Cookie', admin)
      .expect(200)
    expect(billing.body.perJobFeeCents).toBe(2500)
    expect(billing.body.invoices).toMatchObject([{ id: invoice.id, totalCents: 2500 }])

    const paid = await request(app)
      .post(`/api/admin/invoices/${invoice.id}/paid`)
      .set('Cookie', admin)
      .expect(200)
    expect(paid.body.invoice).toMatchObject({ status: 'paid', totalCents: 2500 })
    await request(app)
      .post(`/api/admin/invoices/${invoice.id}/paid`)
      .set('Cookie', admin)
      .expect(404)

    const mine = await request(app).get('/api/billing/invoices').set('Cookie', owner).expect(200)
    expect(mine.body.invoices).toMatchObject([
      { periodStart: '2026-09-01', recoveredJobs: 1, totalCents: 2500, status: 'paid' },
    ])

    const actions = await db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(eq(auditEvents.tenantId, shop.tenant.id))
    expect(actions.map((a) => a.action).sort()).toEqual([
      'billing.invoice_paid',
      'billing.per_job_fee_changed',
    ])
  })

  it('refuses a fee that is not whole cents', async () => {
    const { shop, admin } = await setUp()
    await request(app)
      .put(`/api/admin/tenants/${shop.tenant.id}/per-job-fee`)
      .set('Cookie', admin)
      .send({ perJobFeeCents: 12.5 })
      .expect(400)
  })

  it('keeps the admin routes for the superadmin, and invoices to the owner', async () => {
    const { shop, owner } = await setUp()
    await request(app)
      .put(`/api/admin/tenants/${shop.tenant.id}/per-job-fee`)
      .set('Cookie', owner)
      .send({ perJobFeeCents: 0 })
      .expect(403)
    await request(app).get('/api/billing/invoices').set('Cookie', shop.cookie).expect(403) // office
  })
})
