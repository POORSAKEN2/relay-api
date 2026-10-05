import { and, count, desc, eq, gt, gte, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm'
import { type Db, db } from '../../db/client.ts'
import {
  jobs,
  RECOVERED_JOB_SOURCES,
  type SUBSCRIPTION_STATUSES,
  subscriptionInvoices,
  tenants,
  webhookEvents,
} from '../../db/schema.ts'

type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number]

// Saves that an event arrived. False if it was already saved: a repeat to ignore.
export async function recordWebhookEvent(eventId: string, tx: Db) {
  const saved = await tx
    .insert(webhookEvents)
    .values({ provider: 'revenuecat', eventId })
    .onConflictDoNothing()
    .returning({ eventId: webhookEvents.eventId })
  return saved.length > 0
}

// Only if no later event was applied already, so a late webhook never undoes a newer one.
export async function updateSubscription(
  tenantId: string,
  values: { status: SubscriptionStatus; expiresAt: Date | null; eventAt: Date },
  tx: Db,
) {
  await tx
    .update(tenants)
    .set({
      subscriptionStatus: values.status,
      subscriptionExpiresAt: values.expiresAt,
      subscriptionEventAt: values.eventAt,
    })
    .where(
      and(
        eq(tenants.id, tenantId),
        or(isNull(tenants.subscriptionEventAt), lt(tenants.subscriptionEventAt, values.eventAt)),
      ),
    )
}

export async function findSubscription(tenantId: string) {
  const [tenant] = await db
    .select({
      status: tenants.subscriptionStatus,
      expiresAt: tenants.subscriptionExpiresAt,
    })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
  return tenant
}

// Contractors with a per-job fee, each with the month that last ended in its own time zone:
// on 1 October that is periodStart '2026-09-01', periodEnd '2026-10-01'.
export async function listTenantsToInvoice(now: Date) {
  const thisMonth = sql`date_trunc('month', ${now.toISOString()}::timestamptz at time zone ${tenants.timezone})`
  return db
    .select({
      tenantId: tenants.id,
      timezone: tenants.timezone,
      perJobFeeCents: tenants.perJobFeeCents,
      periodStart: sql<string>`(${thisMonth} - interval '1 month')::date::text`,
      periodEnd: sql<string>`${thisMonth}::date::text`,
    })
    .from(tenants)
    .where(gt(tenants.perJobFeeCents, 0))
}

// Recovered jobs booked from periodStart up to (not including) periodEnd, local dates in the
// contractor's time zone. Holds nobody paid for have no booked_at, so they never count; a
// cancelled job doesn't count either.
export async function countRecoveredJobs(
  tenantId: string,
  timezone: string,
  periodStart: string,
  periodEnd: string,
) {
  const [row] = await db
    .select({ count: count() })
    .from(jobs)
    .where(
      and(
        eq(jobs.tenantId, tenantId),
        inArray(jobs.source, [...RECOVERED_JOB_SOURCES]),
        ne(jobs.status, 'cancelled'),
        gte(jobs.bookedAt, sql`${periodStart}::date::timestamp at time zone ${timezone}`),
        lt(jobs.bookedAt, sql`${periodEnd}::date::timestamp at time zone ${timezone}`),
      ),
    )
  return row.count
}

// False if that month was invoiced already.
export async function insertInvoice(values: typeof subscriptionInvoices.$inferInsert) {
  const saved = await db
    .insert(subscriptionInvoices)
    .values(values)
    .onConflictDoNothing()
    .returning({ id: subscriptionInvoices.id })
  return saved.length > 0
}

const invoiceColumns = {
  id: subscriptionInvoices.id,
  periodStart: subscriptionInvoices.periodStart,
  periodEnd: subscriptionInvoices.periodEnd,
  recoveredJobs: subscriptionInvoices.recoveredJobs,
  perJobFeeCents: subscriptionInvoices.perJobFeeCents,
  totalCents: subscriptionInvoices.totalCents,
  status: subscriptionInvoices.status,
  paidAt: subscriptionInvoices.paidAt,
}

// Newest month first.
export async function listInvoices(tenantId: string) {
  return db
    .select(invoiceColumns)
    .from(subscriptionInvoices)
    .where(eq(subscriptionInvoices.tenantId, tenantId))
    .orderBy(desc(subscriptionInvoices.periodStart))
}

// Only an open invoice can be paid. Undefined if there is no open invoice with that id.
export async function markInvoicePaid(invoiceId: string, tx: Db) {
  const [invoice] = await tx
    .update(subscriptionInvoices)
    .set({ status: 'paid', paidAt: new Date() })
    .where(and(eq(subscriptionInvoices.id, invoiceId), eq(subscriptionInvoices.status, 'open')))
    .returning({ ...invoiceColumns, tenantId: subscriptionInvoices.tenantId })
  return invoice
}

export async function findPerJobFee(tenantId: string, tx: Db = db) {
  const [tenant] = await tx
    .select({ perJobFeeCents: tenants.perJobFeeCents })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
  return tenant
}

export async function updatePerJobFee(tenantId: string, perJobFeeCents: number, tx: Db) {
  await tx.update(tenants).set({ perJobFeeCents }).where(eq(tenants.id, tenantId))
}
