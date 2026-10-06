import { and, eq } from 'drizzle-orm'
import { db } from '../../db/client.ts'
import { calls, tenants } from '../../db/schema.ts'
import { findCustomer, listProperties } from '../customers/customers.queries.ts'
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
