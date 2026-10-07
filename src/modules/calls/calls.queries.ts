import { and, eq, gte, isNull, ne } from 'drizzle-orm'
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
