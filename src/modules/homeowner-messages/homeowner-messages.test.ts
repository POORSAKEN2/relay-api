import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createJob, createShop, resetDb, type Shop } from '../../../test/helpers.ts'
import { db } from '../../db/client.ts'
import { customers, messages, tenants } from '../../db/schema.ts'
import { changeStatus } from '../dispatch/dispatch.service.ts'
import { sendVisitReminders } from './homeowner-messages.service.ts'

vi.mock('../../realtime/index.ts', () => ({ emitToTenant: vi.fn() }))

const HOUR = 3_600_000

beforeEach(resetDb)

function hoursFromNow(hours: number) {
  return new Date(Date.now() + hours * HOUR)
}

// A booked visit starting `startsIn` hours from now, booked `bookedAgo` hours ago.
function visitIn(shop: Shop, startsIn: number, bookedAgo = 72, values = {}) {
  return createJob(shop, {
    windowStartsAt: hoursFromNow(startsIn),
    windowEndsAt: hoursFromNow(startsIn + 4),
    bookedAt: hoursFromNow(-bookedAgo),
    ...values,
  })
}

// A reminder for the job as if it had been saved `hoursAgo` hours ago.
async function remindedAgo(shop: Shop, jobId: string, hoursAgo: number) {
  await db.insert(messages).values({
    tenantId: shop.tenant.id,
    channel: 'sms',
    direction: 'outbound',
    status: 'sent',
    contact: shop.customer.phone!,
    kind: 'reminder',
    body: 'Reminder',
    jobId,
    createdAt: hoursFromNow(-hoursAgo),
  })
}

function reminders() {
  return db.select().from(messages).where(eq(messages.kind, 'reminder'))
}

describe('sendVisitReminders', () => {
  it('reminds a visit a day ahead, only once', async () => {
    const shop = await createShop('desert')
    const job = await visitIn(shop, 23)

    expect(await sendVisitReminders()).toBe(1)
    expect(await sendVisitReminders()).toBe(0)

    const [text] = await reminders()
    expect(text).toMatchObject({ channel: 'sms', jobId: job.id, customerId: shop.customer.id })
    expect(text.body).toMatch(/^desert HVAC: reminder, your AC repair visit is \w{3}, \w{3} \d+, /)
  })

  it('reminds it again two hours before', async () => {
    const shop = await createShop('desert')
    const job = await visitIn(shop, 1.5)
    await remindedAgo(shop, job.id, 22.5) // the day-before reminder

    expect(await sendVisitReminders()).toBe(1)
    expect(await reminders()).toHaveLength(2)
  })

  it('reminds a visit moved to a later day again', async () => {
    const shop = await createShop('desert')
    const job = await visitIn(shop, 23)
    await remindedAgo(shop, job.id, 30) // for the old time

    expect(await sendVisitReminders()).toBe(1)
  })

  it('sends a late visit only one reminder, not both', async () => {
    const shop = await createShop('desert')
    await visitIn(shop, 1)

    expect(await sendVisitReminders()).toBe(1)
    expect(await sendVisitReminders()).toBe(0)
  })

  it('leaves out visits too far off, booked too recently, or not booked', async () => {
    const shop = await createShop('desert')
    await visitIn(shop, 30) // too far off
    await visitIn(shop, 20, 1) // booked 21 hours ahead: the confirmation was enough
    await visitIn(shop, 10, 72, { status: 'cancelled' })
    await visitIn(shop, -1) // already started

    expect(await sendVisitReminders()).toBe(0)
  })

  it('leaves out a homeowner with neither a phone nor an email', async () => {
    const shop = await createShop('desert')
    await db.update(customers).set({ phone: null }).where(eq(customers.id, shop.customer.id))
    await visitIn(shop, 23)

    expect(await sendVisitReminders()).toBe(0)
  })
})

describe('when the office marks a job done', () => {
  async function markDone(shop: Shop) {
    const job = await createJob(shop, { technicianId: shop.mike.id, status: 'in_progress' })
    await changeStatus({
      tenantId: shop.tenant.id,
      actorUserId: shop.office.id,
      jobId: job.id,
      to: 'done',
    })
  }

  it('asks for a review but sends no receipt, since no payment was recorded', async () => {
    const shop = await createShop('desert')
    await db
      .update(tenants)
      .set({ reviewUrl: 'https://g.page/r/desert/review' })
      .where(eq(tenants.id, shop.tenant.id))

    await markDone(shop)

    const sent = await db.select().from(messages)
    expect(sent.map((message) => message.kind)).toEqual(['review_request'])
  })

  it('asks for nothing when the contractor has no review link', async () => {
    const shop = await createShop('desert')

    await markDone(shop)

    expect(await db.select().from(messages)).toHaveLength(0)
  })
})
