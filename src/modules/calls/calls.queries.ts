import { and, eq, gte, isNull, ne, sql } from 'drizzle-orm'
import { type Db, db } from '../../db/client.ts'
import { calls, messages, tenants } from '../../db/schema.ts'

// A call nobody answered, with what a text-back needs to know about the contractor.
export async function findMissedCall(tenantId: string, callId: string, tx: Db = db) {
  const [call] = await tx
    .select({
      id: calls.id,
      fromPhone: calls.fromPhone,
      customerId: calls.customerId,
      tenant: {
        name: tenants.name,
        slug: tenants.slug,
        customDomain: tenants.customDomain,
        customDomainVerifiedAt: tenants.customDomainVerifiedAt,
      },
    })
    .from(calls)
    .innerJoin(tenants, eq(tenants.id, calls.tenantId))
    .where(and(eq(calls.tenantId, tenantId), eq(calls.id, callId), isNull(calls.answeredBy)))
  return call
}

// True if this caller got a text-back since `since`. A blocked one (they texted STOP) never
// reached them, so it doesn't count.
export async function textedBackSince(tenantId: string, contact: string, since: Date, tx: Db) {
  const [text] = await tx
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.tenantId, tenantId),
        eq(messages.contact, contact),
        eq(messages.kind, 'text_back'),
        ne(messages.status, 'blocked'),
        gte(messages.createdAt, since),
      ),
    )
    .limit(1)
  return text !== undefined
}

// A missed call of this contractor that rang since `since`: the one a booking link came from.
export async function findRecentMissedCall(
  tenantId: string,
  callId: string,
  since: Date,
  tx: Db = db,
) {
  const [call] = await tx
    .select({ id: calls.id })
    .from(calls)
    .where(
      and(
        eq(calls.tenantId, tenantId),
        eq(calls.id, callId),
        isNull(calls.answeredBy),
        gte(calls.startedAt, since),
      ),
    )
  return call
}

// The contractor's missed callers due their one next-morning reminder: one row per phone, the
// latest missed call in the range. Only callers whose latest answer to texts is yes (the
// reminder needs consent, and asking here keeps blocked rows out of the messages), who haven't
// booked, started a booking online (that draft gets its own text), got through on a later call
// or texted in since, and weren't reminded since `remindedSince`.
export async function listCallersToRemind(
  tenantId: string,
  range: { since: Date; before: Date; remindedSince: Date },
) {
  const result = await db.execute<{ id: string; phone: string; customerId: string | null }>(sql`
    select distinct on (c.from_phone) c.id, c.from_phone as "phone", c.customer_id as "customerId"
    from calls c
    where c.tenant_id = ${tenantId}
      and c.answered_by is null
      and c.from_phone is not null
      and c.started_at >= ${range.since.toISOString()}
      and c.started_at < ${range.before.toISOString()}
      and (
        select e.granted from consent_events e
        where e.tenant_id = c.tenant_id and e.contact = c.from_phone and e.channel = 'sms'
        order by e.created_at desc
        limit 1
      ) is true
      and not exists (
        select 1 from jobs j
        join customers cu on cu.id = j.customer_id
        where j.tenant_id = c.tenant_id and cu.phone = c.from_phone
          and j.created_at > c.started_at
      )
      and not exists (
        select 1 from booking_drafts d
        where d.tenant_id = c.tenant_id and d.phone = c.from_phone
          and d.created_at > c.started_at
      )
      and not exists (
        select 1 from calls a
        where a.tenant_id = c.tenant_id and a.from_phone = c.from_phone
          and a.answered_by is not null and a.started_at > c.started_at
      )
      and not exists (
        select 1 from messages m
        where m.tenant_id = c.tenant_id and m.contact = c.from_phone
          and m.direction = 'inbound' and m.created_at > c.started_at
      )
      and not exists (
        select 1 from messages m
        where m.tenant_id = c.tenant_id and m.contact = c.from_phone
          and m.kind = 'missed_caller_reminder'
          and m.created_at > ${range.remindedSince.toISOString()}
      )
    order by c.from_phone, c.started_at desc
  `)
  return result.rows
}
