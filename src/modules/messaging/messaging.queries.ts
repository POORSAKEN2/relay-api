import { and, desc, eq, inArray, isNull, lte, ne, sql } from 'drizzle-orm'
import { type Db, db } from '../../db/client.ts'
import { consentEvents, messages, phoneNumbers, tenants } from '../../db/schema.ts'

// Tenant-scoped queries take tenantId first. The sender's work on a message by id is not
// tenant-scoped: it serves every contractor.

// The newest consent for this phone, or undefined if they were never asked.
export async function findLatestConsent(tenantId: string, contact: string, tx: Db = db) {
  const [consent] = await tx
    .select({ granted: consentEvents.granted })
    .from(consentEvents)
    .where(
      and(
        eq(consentEvents.tenantId, tenantId),
        eq(consentEvents.contact, contact),
        eq(consentEvents.channel, 'sms'),
      ),
    )
    .orderBy(desc(consentEvents.createdAt))
    .limit(1)
  return consent
}

export async function findQuietHours(tenantId: string, tx: Db = db) {
  const [tenant] = await tx
    .select({
      timezone: tenants.timezone,
      start: tenants.quietHoursStart,
      end: tenants.quietHoursEnd,
    })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
  return tenant
}

export async function insertText(values: typeof messages.$inferInsert, tx: Db = db) {
  const [message] = await tx.insert(messages).values(values).returning({ id: messages.id })
  return message
}

// The number this contractor's texts go out from, if they have one.
export async function findSendingNumber(tenantId: string) {
  const [phone] = await db
    .select({ number: phoneNumbers.number })
    .from(phoneNumbers)
    .where(and(eq(phoneNumbers.tenantId, tenantId), eq(phoneNumbers.status, 'active')))
    .limit(1)
  return phone?.number
}

// Takes up to `limit` texts that are due and counts a try on each. Pushing send_after a minute
// ahead is the lease: if the process dies mid-send, the text comes back then, and another
// instance skips rows this one has locked. Sign-in codes are sent by sendText() itself.
export function claimDueTexts(limit: number) {
  const due = db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.channel, 'sms'),
        eq(messages.status, 'queued'),
        isNull(messages.providerMessageId),
        lte(messages.sendAfter, sql`now()`),
        ne(messages.kind, 'sign_in_code'),
      ),
    )
    .orderBy(messages.sendAfter)
    .limit(limit)
    .for('update', { skipLocked: true })
  return db
    .update(messages)
    .set({
      attempts: sql`${messages.attempts} + 1`,
      sendAfter: sql`now() + interval '1 minute'`,
    })
    .where(inArray(messages.id, due))
    .returning({
      id: messages.id,
      tenantId: messages.tenantId,
      contact: messages.contact,
      body: messages.body,
      attempts: messages.attempts,
    })
}

// The provider took it. The status stays 'queued' until the phone reports it sent.
export async function markHandedOver(messageId: string, providerMessageId: string) {
  await db
    .update(messages)
    .set({ providerMessageId, lastError: null })
    .where(eq(messages.id, messageId))
}

// Only the 'log' provider: nothing will report back, so it counts as sent at once.
export async function markLogged(messageId: string) {
  await db.update(messages).set({ status: 'sent' }).where(eq(messages.id, messageId))
}

export async function recordSendError(messageId: string, error: string) {
  await db.update(messages).set({ lastError: error }).where(eq(messages.id, messageId))
}

export async function markFailed(messageId: string, error: string) {
  await db
    .update(messages)
    .set({ status: 'failed', lastError: error })
    .where(eq(messages.id, messageId))
}
