import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  createJob,
  createShop,
  resetDb,
  type Shop,
  setMorning,
  setQuietNow,
} from '../../../test/helpers.ts'
import { db } from '../../db/client.ts'
import { bookingDrafts, calls, consentEvents, messages } from '../../db/schema.ts'
import { sendMissedCallerReminders } from './calls.service.ts'

// The shop's customer, so a job made with createJob counts as this caller's booking.
const CALLER = '+16025550111'

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000)

beforeEach(resetDb)

// A shop whose morning was 3 hours ago: calls from 27 to 3 hours ago are due a reminder.
async function morningShop(slug = 'desert') {
  const shop = await createShop(slug)
  await setMorning(shop.tenant.id, 180)
  return shop
}

// Missed 5 hours ago, before this morning, unless told otherwise.
async function missedCall(shop: Shop, values: Partial<typeof calls.$inferInsert> = {}) {
  const [row] = await db
    .insert(calls)
    .values({
      tenantId: shop.tenant.id,
      providerSid: randomUUID(),
      fromPhone: CALLER,
      toPhone: '+14805550100',
      startedAt: minutesAgo(5 * 60),
      ...values,
    })
    .returning()
  return row
}

async function consent(shop: Shop, granted: boolean, at = minutesAgo(30 * 24 * 60)) {
  await db.insert(consentEvents).values({
    tenantId: shop.tenant.id,
    contact: CALLER,
    channel: 'sms',
    granted,
    source: 'booking_form',
    createdAt: at,
  })
}

function reminders() {
  return db.select().from(messages).where(eq(messages.kind, 'missed_caller_reminder'))
}

describe('sendMissedCallerReminders', () => {
  it('texts a caller who agreed to texts once, with the open times and the call link', async () => {
    const shop = await morningShop()
    await consent(shop, true)
    const missed = await missedCall(shop)

    expect(await sendMissedCallerReminders()).toBe(1)

    const [text] = await reminders()
    expect(text).toMatchObject({
      tenantId: shop.tenant.id,
      contact: CALLER,
      status: 'queued',
      callId: missed.id,
    })
    expect(text.body).toMatch(/^desert HVAC: still need a visit\? Sorry we missed your call\. /)
    expect(text.body.match(/\d{1,2} (AM|PM) - \d{1,2} (AM|PM)/g)).toHaveLength(3)
    expect(text.body).toContain(`https://desert.localhost/?call=${missed.id}&phone=%2B16025550111`)

    // At most one a week.
    expect(await sendMissedCallerReminders()).toBe(0)
    expect(await reminders()).toHaveLength(1)
  })

  it('sends one text for several missed calls, about the latest', async () => {
    const shop = await morningShop()
    await consent(shop, true)
    await missedCall(shop, { startedAt: minutesAgo(6 * 60) })
    const latest = await missedCall(shop, { startedAt: minutesAgo(5 * 60) })

    expect(await sendMissedCallerReminders()).toBe(1)
    expect((await reminders())[0].callId).toBe(latest.id)
  })

  it('never texts a caller without consent, or one who opted out', async () => {
    const shop = await morningShop()
    await missedCall(shop)
    expect(await sendMissedCallerReminders()).toBe(0)

    await consent(shop, true, minutesAgo(10 * 24 * 60))
    await consent(shop, false, minutesAgo(24 * 60)) // texted STOP since
    expect(await sendMissedCallerReminders()).toBe(0)
    expect(await db.select().from(messages)).toHaveLength(0)
  })

  it('leaves alone a caller who booked, started online, got through or texted in', async () => {
    for (const after of ['booked', 'draft', 'answered', 'texted'] as const) {
      await resetDb()
      const shop = await morningShop()
      await consent(shop, true)
      await missedCall(shop)

      if (after === 'booked') await createJob(shop)
      if (after === 'draft') {
        await db.insert(bookingDrafts).values({
          tenantId: shop.tenant.id,
          token: randomUUID(),
          name: 'Maria Lopez',
          phone: CALLER,
          zip: '85004',
          createdAt: minutesAgo(4 * 60),
        })
      }
      if (after === 'answered') {
        await missedCall(shop, { answeredBy: 'office', startedAt: minutesAgo(4 * 60) })
      }
      if (after === 'texted') {
        await db.insert(messages).values({
          tenantId: shop.tenant.id,
          channel: 'sms',
          direction: 'inbound',
          contact: CALLER,
          kind: 'inbound',
          body: 'Can you come Friday?',
          status: 'received',
        })
      }

      expect(await sendMissedCallerReminders(), after).toBe(0)
    }
  })

  it('waits a week after the last reminder', async () => {
    const shop = await morningShop()
    await consent(shop, true)
    await missedCall(shop)
    await db.insert(messages).values({
      tenantId: shop.tenant.id,
      channel: 'sms',
      direction: 'outbound',
      contact: CALLER,
      kind: 'missed_caller_reminder',
      body: 'earlier reminder',
      status: 'delivered',
      createdAt: minutesAgo(3 * 24 * 60),
    })

    expect(await sendMissedCallerReminders()).toBe(0)
  })

  it('only texts calls from the previous morning up to this one', async () => {
    const shop = await morningShop()
    await consent(shop, true)
    await missedCall(shop, { startedAt: minutesAgo(120) }) // after this morning: tomorrow
    await missedCall(shop, { startedAt: minutesAgo(28 * 60) }) // before the previous morning
    await missedCall(shop, { fromPhone: null }) // caller ID hidden

    expect(await sendMissedCallerReminders()).toBe(0)
  })

  it('texts nobody while the contractor is in quiet hours', async () => {
    const shop = await createShop('desert')
    await setQuietNow(shop.tenant.id)
    await consent(shop, true)
    await missedCall(shop, { startedAt: minutesAgo(20 * 60) })

    expect(await sendMissedCallerReminders()).toBe(0)
  })
})
