import { env } from '../../config/env.ts'
import { db } from '../../db/client.ts'
import type { SUBSCRIPTION_STATUSES } from '../../db/schema.ts'
import { HttpError } from '../../lib/http-error.ts'
import { logger } from '../../lib/logger.ts'
import type { SessionUser } from '../accounts/accounts.service.ts'
import * as audit from '../audit/audit.queries.ts'
import { tenantOf } from '../booking/booking.service.ts'
import * as queries from './billing.queries.ts'
import type { RevenueCatEvent } from './billing.schemas.ts'

// The contractor's Relay subscription. What it owes, when it was paid and how are RevenueCat's
// to know: the webhook below only keeps our copy of the status in step.

type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number]

// What each RevenueCat event type makes the subscription. A cancellation isn't listed: the
// contractor keeps access until the period ends, when an EXPIRATION event arrives.
const STATUS_AFTER: Record<string, SubscriptionStatus> = {
  INITIAL_PURCHASE: 'active',
  RENEWAL: 'active',
  UNCANCELLATION: 'active',
  PRODUCT_CHANGE: 'active',
  NON_RENEWING_PURCHASE: 'active',
  SUBSCRIPTION_EXTENDED: 'active',
  BILLING_ISSUE: 'billing_issue',
  EXPIRATION: 'expired',
}

// Sandbox purchases (test cards) must never change a real contractor, and the reverse.
function isThisEnvironment(event: RevenueCatEvent) {
  return event.environment === (env.NODE_ENV === 'production' ? 'PRODUCTION' : 'SANDBOX')
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// One event, in one transaction with the record that it arrived: if handling fails, RevenueCat
// retries and the retry isn't mistaken for a repeat.
export async function handleRevenueCatEvent(event: RevenueCatEvent) {
  const status = STATUS_AFTER[event.type]
  if (!status || !isThisEnvironment(event) || !UUID.test(event.app_user_id)) {
    logger.info({ type: event.type, environment: event.environment }, 'RevenueCat event ignored')
    return
  }
  await db.transaction(async (tx) => {
    if (!(await queries.recordWebhookEvent(event.id, tx))) return // a repeat
    await queries.updateSubscription(
      event.app_user_id,
      {
        status,
        expiresAt: event.expiration_at_ms ? new Date(event.expiration_at_ms) : null,
        eventAt: new Date(event.event_timestamp_ms),
      },
      tx,
    )
  })
}

export async function getSubscription(user: SessionUser) {
  const tenantId = tenantOf(user)
  // tenantId is also the id the web app signs in to RevenueCat with.
  return { tenantId, ...(await queries.findSubscription(tenantId)) }
}

// The per-recovered-job fee. RevenueCat can't charge a different amount each month, so Relay
// makes its own invoice for it once a month and the superadmin marks it paid when the money
// arrives.

// Run daily by pg-boss. For each contractor with a per-job fee, counts the recovered jobs of
// the month that last ended in its time zone and freezes them, at today's fee, into an
// invoice. A month already invoiced is left alone, so a rerun or a missed day is safe.
// Returns how many invoices were made.
export async function createMonthlyInvoices(now = new Date()) {
  let created = 0
  for (const tenant of await queries.listTenantsToInvoice(now)) {
    const { tenantId, timezone, perJobFeeCents, periodStart, periodEnd } = tenant
    const recoveredJobs = await queries.countRecoveredJobs(
      tenantId,
      timezone,
      periodStart,
      periodEnd,
    )
    if (recoveredJobs === 0) continue // nothing to pay
    const saved = await queries.insertInvoice({
      tenantId,
      periodStart,
      periodEnd,
      monthlyFeeCents: 0, // paid through RevenueCat
      recoveredJobs,
      perJobFeeCents,
      totalCents: recoveredJobs * perJobFeeCents,
    })
    if (saved) created++
  }
  return created
}

export function listInvoices(user: SessionUser) {
  return queries.listInvoices(tenantOf(user))
}

// The superadmin's view of one contractor: its fee and its invoices.
export async function getTenantBilling(tenantId: string) {
  const tenant = await queries.findPerJobFee(tenantId)
  if (!tenant) throw new HttpError(404, 'not_found', 'Contractor not found')
  return { perJobFeeCents: tenant.perJobFeeCents, invoices: await queries.listInvoices(tenantId) }
}

// A new fee applies from the next invoice made; invoices already made keep theirs.
export async function setPerJobFee(admin: SessionUser, tenantId: string, perJobFeeCents: number) {
  await db.transaction(async (tx) => {
    const current = await queries.findPerJobFee(tenantId, tx)
    if (!current) throw new HttpError(404, 'not_found', 'Contractor not found')
    if (current.perJobFeeCents === perJobFeeCents) return
    await queries.updatePerJobFee(tenantId, perJobFeeCents, tx)
    await audit.insertUserAction(
      tenantId,
      {
        actorUserId: admin.id,
        action: 'billing.per_job_fee_changed',
        entityType: 'tenant',
        entityId: tenantId,
        data: { from: current.perJobFeeCents, to: perJobFeeCents },
      },
      tx,
    )
  })
  return { perJobFeeCents }
}

export async function markInvoicePaid(admin: SessionUser, invoiceId: string) {
  return db.transaction(async (tx) => {
    const paid = await queries.markInvoicePaid(invoiceId, tx)
    if (!paid) throw new HttpError(404, 'not_found', 'No unpaid invoice with that id')
    const { tenantId, ...invoice } = paid
    await audit.insertUserAction(
      tenantId,
      {
        actorUserId: admin.id,
        action: 'billing.invoice_paid',
        entityType: 'subscription_invoice',
        entityId: invoiceId,
        data: { totalCents: invoice.totalCents },
      },
      tx,
    )
    return invoice
  })
}
