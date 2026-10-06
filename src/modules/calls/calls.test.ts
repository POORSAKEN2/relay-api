import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { createTenant, resetDb } from '../../../test/helpers.ts'
import { db } from '../../db/client.ts'
import { calls, consentEvents, messages } from '../../db/schema.ts'
import { textBackMissedCall } from './calls.service.ts'

const CALLER = '+16025550111'

beforeEach(resetDb)

async function call(tenantId: string, values: Partial<typeof calls.$inferInsert> = {}) {
  const [row] = await db
    .insert(calls)
    .values({
      tenantId,
      providerSid: randomUUID(),
      fromPhone: CALLER,
      toPhone: '+14805550100',
      ...values,
    })
    .returning()
  return row
}

function textBack(tenantId: string, callId: string) {
  return db.transaction((tx) => textBackMissedCall(tenantId, callId, tx))
}

function textsTo(contact: string) {
  return db.select().from(messages).where(eq(messages.contact, contact))
}

describe('textBackMissedCall', () => {
  it('saves a text-back with a booking link that names the call and the phone', async () => {
    const tenant = await createTenant('desert')
    const missed = await call(tenant.id)

    await textBack(tenant.id, missed.id)

    const [text] = await textsTo(CALLER)
    expect(text).toMatchObject({
      kind: 'text_back',
      status: 'queued',
      callId: missed.id,
      body: `desert HVAC: sorry we missed your call. Book a visit here: https://desert.localhost/?call=${missed.id}&phone=%2B16025550111 Reply STOP to opt out.`,
    })
  })

  it('texts nobody when the caller hid their number or the call was answered', async () => {
    const tenant = await createTenant('desert')
    const hidden = await call(tenant.id, { fromPhone: null })
    const answered = await call(tenant.id, { answeredBy: 'office' })

    await textBack(tenant.id, hidden.id)
    await textBack(tenant.id, answered.id)

    expect(await db.select().from(messages)).toHaveLength(0)
  })

  it('texts a caller once, however many times they ring in 12 hours', async () => {
    const tenant = await createTenant('desert')
    const first = await call(tenant.id)
    const second = await call(tenant.id)

    await textBack(tenant.id, first.id)
    await textBack(tenant.id, second.id)

    expect(await textsTo(CALLER)).toHaveLength(1)
  })

  it('texts again once the last text-back is older than 12 hours', async () => {
    const tenant = await createTenant('desert')
    const earlier = await call(tenant.id)
    await textBack(tenant.id, earlier.id)
    await db
      .update(messages)
      .set({ createdAt: new Date(Date.now() - 13 * 3_600_000) })
      .where(eq(messages.callId, earlier.id))

    await textBack(tenant.id, (await call(tenant.id)).id)

    expect(await textsTo(CALLER)).toHaveLength(2)
  })

  it('keeps a blocked text-back as the record, and it doesn’t count as texted', async () => {
    const tenant = await createTenant('desert')
    await db.insert(consentEvents).values({
      tenantId: tenant.id,
      contact: CALLER,
      channel: 'sms',
      granted: false,
      source: 'office',
    })
    const first = await call(tenant.id)
    await textBack(tenant.id, first.id)
    expect((await textsTo(CALLER))[0]).toMatchObject({
      status: 'blocked',
      blockedReason: 'opted_out',
    })

    // They text START, then ring again: this time the text goes out.
    await db.insert(consentEvents).values({
      tenantId: tenant.id,
      contact: CALLER,
      channel: 'sms',
      granted: true,
      source: 'office',
    })
    await textBack(tenant.id, (await call(tenant.id)).id)

    const statuses = (await textsTo(CALLER)).map((text) => text.status).sort()
    expect(statuses).toEqual(['blocked', 'queued'])
  })

  it('ignores a call of another contractor', async () => {
    const tenant = await createTenant('desert')
    const other = await createTenant('other')
    const theirs = await call(other.id)

    await textBack(tenant.id, theirs.id)

    expect(await db.select().from(messages)).toHaveLength(0)
  })
})
