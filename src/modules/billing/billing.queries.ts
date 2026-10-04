import { and, eq, isNull, lt, or } from 'drizzle-orm'
import { type Db, db } from '../../db/client.ts'
import { type SUBSCRIPTION_STATUSES, tenants, webhookEvents } from '../../db/schema.ts'

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
