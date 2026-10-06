import { and, eq, isNull, sql } from 'drizzle-orm'
import { type Db, db } from '../../db/client.ts'
import { calls, jobs, tenants } from '../../db/schema.ts'
import { findCustomer, listProperties } from '../customers/customers.queries.ts'
import { localOrNull } from '../dispatch/dispatch.queries.ts'
import { findCustomerIdByPhone } from '../messaging/messaging.queries.ts'

export async function findTenant(tenantId: string) {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId))
  return tenant
}

// A call the AI answers. The disclosure ("I'm an AI, and this call is recorded") is the
// greeting's first words, so it is saved with the answer itself (DB check calls_ai_disclosed).
export async function insertAiCall(
  tenantId: string,
  values: {
    providerSid: string
    fromPhone: string | null
    toPhone: string
    customerId: string | undefined
  },
) {
  const [call] = await db
    .insert(calls)
    .values({ tenantId, ...values, answeredBy: 'ai', disclosedAt: new Date() })
    .returning({ id: calls.id })
  return call.id
}

export async function updateCall(
  tenantId: string,
  callId: string,
  change: Partial<
    Pick<
      typeof calls.$inferInsert,
      'priority' | 'safetyFlag' | 'transferredAt' | 'endedAt' | 'transcript' | 'summary'
    >
  >,
) {
  await db
    .update(calls)
    .set(change)
    .where(and(eq(calls.tenantId, tenantId), eq(calls.id, callId)))
}

// The customer the caller ID belongs to (the oldest one with that phone) and their saved
// addresses, so the AI can ask "Is this about 12 Palm St?". undefined for a new caller.
export async function findCallerContext(tenantId: string, phone: string) {
  const customerId = await findCustomerIdByPhone(tenantId, phone, db)
  if (!customerId) return undefined
  const customer = await findCustomer(tenantId, customerId)
  const properties = await listProperties(tenantId, [customerId])
  return {
    customerId,
    name: customer.name,
    addresses: properties.map(
      (property) =>
        `${property.street}${property.unit ? ` ${property.unit}` : ''}, ${property.city}`,
    ),
  }
}

// What the wrap-up needs about an AI call: its transcript, what happened, and the job it
// booked (with its local day and window), if any.
export async function findCallToWrapUp(tenantId: string, callId: string) {
  const [call] = await db
    .select({
      transcript: calls.transcript,
      summary: calls.summary,
      safetyFlag: calls.safetyFlag,
      transferredAt: calls.transferredAt,
      messageTaken: sql<boolean>`exists (
        select 1 from callback_requests
        where callback_requests.tenant_id = ${calls.tenantId} and callback_requests.call_id = ${calls.id}
      )`,
      jobId: jobs.id,
      jobDate: localOrNull(jobs.windowStartsAt, 'YYYY-MM-DD'),
      jobStartsAt: localOrNull(jobs.windowStartsAt, 'HH24:MI:SS'),
      jobEndsAt: localOrNull(jobs.windowEndsAt, 'HH24:MI:SS'),
    })
    .from(calls)
    .innerJoin(tenants, eq(tenants.id, calls.tenantId))
    .leftJoin(jobs, and(eq(jobs.tenantId, calls.tenantId), eq(jobs.callId, calls.id)))
    .where(and(eq(calls.tenantId, tenantId), eq(calls.id, callId)))
    .limit(1)
  return call
}

// Saves the summary only if the call has none yet. False when another run of the job got
// there first, so its note isn't added twice.
export async function saveSummary(tenantId: string, callId: string, summary: string, tx: Db) {
  const saved = await tx
    .update(calls)
    .set({ summary })
    .where(and(eq(calls.tenantId, tenantId), eq(calls.id, callId), isNull(calls.summary)))
    .returning({ id: calls.id })
  return saved.length > 0
}
