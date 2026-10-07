import { and, count, desc, eq, isNull, sql } from 'drizzle-orm'
import { type Db, db } from '../../db/client.ts'
import { messages, users } from '../../db/schema.ts'

// The texts the inbox shows: one contractor's SMS with homeowners. Texts to the contractor's
// own people (job assigned, office alerts, sign-in codes) have a to_user_id and are left out.
// Every query below starts from this, so staff texts never leak into a thread.
function homeownerTexts(tenantId: string) {
  return and(
    eq(messages.tenantId, tenantId),
    eq(messages.channel, 'sms'),
    isNull(messages.toUserId),
  )
}

const unreadInbound = and(eq(messages.direction, 'inbound'), isNull(messages.readAt))

type ThreadRow = {
  contact: string
  body: string
  direction: 'inbound' | 'outbound'
  created_at: Date
  unread: number
  customer_id: string | null
  customer_name: string | null
}

// One row per phone number, most recently active first: its latest text, how many of its
// texts from the homeowner are unread, and the oldest customer with that phone (if any).
export async function listThreads(tenantId: string, limit: number) {
  const result = await db.execute<ThreadRow>(sql`
    with homeowner_texts as (
      select * from ${messages} where ${homeownerTexts(tenantId)}
    ),
    latest as (
      select distinct on (contact) contact, body, direction, created_at
      from homeowner_texts
      order by contact, created_at desc
    ),
    unread as (
      select contact, count(*)::int as unread
      from homeowner_texts
      where direction = 'inbound' and read_at is null
      group by contact
    )
    select latest.contact, latest.body, latest.direction, latest.created_at,
      coalesce(unread.unread, 0) as unread,
      customer.id as customer_id, customer.name as customer_name
    from latest
    left join unread on unread.contact = latest.contact
    left join lateral (
      select id, name from customers
      where tenant_id = ${tenantId} and phone = latest.contact
      order by created_at
      limit 1
    ) customer on true
    order by latest.created_at desc
    limit ${limit}
  `)
  return result.rows
}

export async function countUnread(tenantId: string) {
  const [row] = await db
    .select({ unread: count() })
    .from(messages)
    .where(and(homeownerTexts(tenantId), unreadInbound))
  return row.unread
}

// The newest `limit` texts of one thread, newest first, with who typed each office reply.
export function listThreadMessages(tenantId: string, contact: string, limit: number) {
  return db
    .select({
      id: messages.id,
      direction: messages.direction,
      kind: messages.kind,
      body: messages.body,
      status: messages.status,
      blockedReason: messages.blockedReason,
      createdAt: messages.createdAt,
      sentByName: users.name,
    })
    .from(messages)
    .leftJoin(users, eq(users.id, messages.sentByUserId))
    .where(and(homeownerTexts(tenantId), eq(messages.contact, contact)))
    .orderBy(desc(messages.createdAt))
    .limit(limit)
}

export async function threadExists(tenantId: string, contact: string, tx: Db = db) {
  const [text] = await tx
    .select({ id: messages.id })
    .from(messages)
    .where(and(homeownerTexts(tenantId), eq(messages.contact, contact)))
    .limit(1)
  return text !== undefined
}

export async function markThreadRead(tenantId: string, contact: string) {
  await db
    .update(messages)
    .set({ readAt: sql`now()` })
    .where(and(homeownerTexts(tenantId), eq(messages.contact, contact), unreadInbound))
}
