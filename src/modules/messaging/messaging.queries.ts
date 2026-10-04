import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, ne, or, sql } from 'drizzle-orm'
import { type Db, db } from '../../db/client.ts'
import {
  calls,
  consentEvents,
  customers,
  MESSAGE_MAX_ATTEMPTS,
  type MESSAGE_STATUSES,
  messages,
  phoneNumbers,
  tenants,
  webhookEvents,
} from '../../db/schema.ts'

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

// Who an email is from: the contractor's name, with replies going to their own email.
export async function findEmailSender(tenantId: string) {
  const [tenant] = await db
    .select({ name: tenants.name, contactEmail: tenants.contactEmail })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
  return tenant
}

// Messages the process died sending on their last try: they came back when their lease ran
// out, but have no try left. Without this they would be claimed forever (and a 4th try breaks
// the attempts check). Sign-in codes are left to sendText(), which is still sending them.
export async function failUnfinished(channel: 'sms' | 'email') {
  await db
    .update(messages)
    .set({ status: 'failed', lastError: 'Stopped during its last try' })
    .where(
      and(
        eq(messages.channel, channel),
        eq(messages.status, 'queued'),
        isNull(messages.providerMessageId),
        lte(messages.sendAfter, sql`now()`),
        ne(messages.kind, 'sign_in_code'),
        gte(messages.attempts, MESSAGE_MAX_ATTEMPTS),
      ),
    )
}

// Takes up to `limit` texts or emails that are due and counts a try on each. Pushing
// send_after a minute ahead is the lease: if the process dies mid-send, the message comes back
// then, and another instance skips rows this one has locked. Sign-in codes are sent by
// sendText() itself.
export function claimDue(channel: 'sms' | 'email', limit: number) {
  const due = db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.channel, channel),
        eq(messages.status, 'queued'),
        isNull(messages.providerMessageId),
        lte(messages.sendAfter, sql`now()`),
        ne(messages.kind, 'sign_in_code'),
        lt(messages.attempts, MESSAGE_MAX_ATTEMPTS),
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
      subject: messages.subject,
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

// The email server took it. Email has no webhook, so this is final.
export async function markEmailSent(messageId: string, providerMessageId: string) {
  await db
    .update(messages)
    .set({ status: 'sent', providerMessageId, lastError: null })
    .where(eq(messages.id, messageId))
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

// ----- Webhooks -----

// Saves that an event arrived. False if it was already saved: a repeat to ignore.
export async function recordWebhookEvent(eventId: string, tx: Db) {
  const saved = await tx
    .insert(webhookEvents)
    .values({ provider: 'httpsms', eventId })
    .onConflictDoNothing()
    .returning({ eventId: webhookEvents.eventId })
  return saved.length > 0
}

// Moves an outbound text to `status`, only from one of `from`, so a late event never undoes a
// later one. The text is found by our id (httpSMS's request_id) or by httpSMS's id.
export async function updateTextStatus(
  find: { messageId: string | null; providerMessageId: string | null },
  change: { status: (typeof MESSAGE_STATUSES)[number]; lastError?: string },
  from: (typeof MESSAGE_STATUSES)[number][],
  tx: Db,
) {
  const matches = [
    find.messageId ? eq(messages.id, find.messageId) : undefined,
    find.providerMessageId ? eq(messages.providerMessageId, find.providerMessageId) : undefined,
  ].filter((match) => match !== undefined)
  if (matches.length === 0) return
  await tx
    .update(messages)
    .set(change)
    .where(and(eq(messages.direction, 'outbound'), inArray(messages.status, from), or(...matches)))
}

// The contractor whose active number this is.
export async function findTenantIdByNumber(number: string, tx: Db) {
  const [phone] = await tx
    .select({ tenantId: phoneNumbers.tenantId })
    .from(phoneNumbers)
    .where(and(eq(phoneNumbers.number, number), eq(phoneNumbers.status, 'active')))
  return phone?.tenantId
}

// The oldest customer with this phone, if any.
export async function findCustomerIdByPhone(tenantId: string, phone: string, tx: Db) {
  const [customer] = await tx
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.tenantId, tenantId), eq(customers.phone, phone)))
    .orderBy(asc(customers.createdAt))
    .limit(1)
  return customer?.id
}

export async function insertReplyConsent(
  tenantId: string,
  values: { contact: string; granted: boolean; messageId: string },
  tx: Db,
) {
  await tx
    .insert(consentEvents)
    .values({ tenantId, channel: 'sms', source: 'sms_reply', ...values })
}

export async function insertMissedCall(
  tenantId: string,
  values: Omit<typeof calls.$inferInsert, 'tenantId'>,
  tx: Db,
) {
  await tx
    .insert(calls)
    .values({ tenantId, ...values })
    .onConflictDoNothing()
}
