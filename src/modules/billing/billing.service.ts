import { env } from '../../config/env.ts'
import { db } from '../../db/client.ts'
import type { SUBSCRIPTION_STATUSES } from '../../db/schema.ts'
import { logger } from '../../lib/logger.ts'
import type { SessionUser } from '../accounts/accounts.service.ts'
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
