import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createJob,
  createShop,
  resetDb,
  type Shop,
  signInTechnician,
} from '../../../test/helpers.ts'
import { createApp } from '../../app.ts'
import { db } from '../../db/client.ts'
import { auditEvents, priceItems } from '../../db/schema.ts'
import { emitToTenant } from '../../realtime/index.ts'

vi.mock('../../realtime/index.ts', () => ({ emitToTenant: vi.fn() }))

const app = createApp()

beforeEach(async () => {
  await resetDb()
  vi.mocked(emitToTenant).mockClear()
})

// Today in Phoenix, where the test shop is: the technician's list shows today onwards.
function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Phoenix' }).format(new Date())
}

async function addPrice(shop: Shop, name: string, priceCents: number, archived = false) {
  const [item] = await db
    .insert(priceItems)
    .values({
      tenantId: shop.tenant.id,
      name,
      priceCents,
      archivedAt: archived ? new Date() : null,
    })
    .returning()
  return item
}

// One of Mike's jobs today, in progress, and his session.
async function mikesJob() {
  const shop = await createShop('desert')
  const job = await createJob(shop, {
    technicianId: shop.mike.id,
    at: `${today()} 08:00`,
    status: 'in_progress',
  })
  return { shop, job, cookie: await signInTechnician(shop.mike) }
}

function repairs(cookie: string, jobId: string) {
  return {
    add: (body: object) =>
      request(app).post(`/api/my-jobs/${jobId}/repairs`).set('Cookie', cookie).send(body),
    remove: (itemId: string) =>
      request(app).delete(`/api/my-jobs/${jobId}/repairs/${itemId}`).set('Cookie', cookie),
    decide: (decision: string) =>
      request(app)
        .post(`/api/my-jobs/${jobId}/repairs/decision`)
        .set('Cookie', cookie)
        .send({ decision }),
  }
}

describe('POST /api/my-jobs/:jobId/repairs', () => {
  it('adds a repair from the price list, waiting for the homeowner, at the listed price', async () => {
    const { shop, job, cookie } = await mikesJob()
    const capacitor = await addPrice(shop, 'Capacitor replacement', 18500)

    const res = await repairs(cookie, job.id)
      .add({ priceItemId: capacitor.id, quantity: 2 })
      .expect(200)

    expect(res.body.charges).toEqual({
      lines: [
        {
          id: expect.any(String),
          description: 'Capacitor replacement',
          quantity: 2,
          unitPriceCents: 18500,
          totalCents: 37000,
          status: 'proposed',
          removable: true,
        },
      ],
      approvedTotalCents: 0,
      proposedTotalCents: 37000,
    })
    // A later price change doesn't touch the job.
    await db.update(priceItems).set({ priceCents: 20000 }).where(eq(priceItems.id, capacitor.id))
    const page = await request(app).get(`/api/my-jobs/${job.id}`).set('Cookie', cookie).expect(200)
    expect(page.body.charges.lines[0].unitPriceCents).toBe(18500)

    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'job.repair_proposed'))
    expect(audit).toMatchObject({
      actorUserId: shop.mike.id,
      entityId: job.id,
      data: { description: 'Capacitor replacement', quantity: 2, unitPriceCents: 18500 },
    })
    expect(emitToTenant).toHaveBeenCalledWith(shop.tenant.id, 'job.charges_changed', {
      jobId: job.id,
      dates: [today()],
    })
  })

  it('needs the job in progress, a price on the list and a quantity from 1 to 20', async () => {
    const { shop, job, cookie } = await mikesJob()
    const price = await addPrice(shop, 'Contactor replacement', 16500)
    const archived = await addPrice(shop, 'Old part', 5000, true)
    const booked = await createJob(shop, {
      technicianId: shop.mike.id,
      at: `${today()} 12:00`,
      status: 'booked',
    })

    const notStarted = await repairs(cookie, booked.id)
      .add({ priceItemId: price.id, quantity: 1 })
      .expect(422)
    expect(notStarted.body.error.message).toBe('Start the job before adding repairs.')

    const gone = await repairs(cookie, job.id)
      .add({ priceItemId: archived.id, quantity: 1 })
      .expect(422)
    expect(gone.body.error.message).toBe('That price isn’t on the list anymore.')

    const tooMany = await repairs(cookie, job.id)
      .add({ priceItemId: price.id, quantity: 21 })
      .expect(400)
    expect(tooMany.body.error.details.quantity).toEqual(['Pick a quantity from 1 to 20'])
  })
})

describe('DELETE /api/my-jobs/:jobId/repairs/:itemId', () => {
  it('removes only repairs still waiting for the homeowner', async () => {
    const { shop, job, cookie } = await mikesJob()
    const price = await addPrice(shop, 'Drain line flush', 12000)
    const jobRepairs = repairs(cookie, job.id)

    const added = await jobRepairs.add({ priceItemId: price.id, quantity: 1 }).expect(200)
    const removed = await jobRepairs.remove(added.body.charges.lines[0].id).expect(200)
    expect(removed.body.charges.lines).toEqual([])

    const again = await jobRepairs.add({ priceItemId: price.id, quantity: 1 }).expect(200)
    await jobRepairs.decide('approved').expect(200)
    const locked = await jobRepairs.remove(again.body.charges.lines[0].id).expect(422)
    expect(locked.body.error.message).toBe('Only repairs waiting for the homeowner can be removed.')

    const unknown = await jobRepairs.remove(randomUUID()).expect(404)
    expect(unknown.body.error.message).toBe('That repair isn’t on this job.')
  })
})

describe('POST /api/my-jobs/:jobId/repairs/decision', () => {
  it('approves or declines every waiting repair at once', async () => {
    const { shop, job, cookie } = await mikesJob()
    const capacitor = await addPrice(shop, 'Capacitor replacement', 18500)
    const refrigerant = await addPrice(shop, 'Refrigerant (per lb)', 9500)
    const jobRepairs = repairs(cookie, job.id)
    await jobRepairs.add({ priceItemId: capacitor.id, quantity: 1 }).expect(200)
    await jobRepairs.add({ priceItemId: refrigerant.id, quantity: 2 }).expect(200)

    const approved = await jobRepairs.decide('approved').expect(200)
    const { lines } = approved.body.charges
    expect(lines.map((line: { status: string }) => line.status)).toEqual(['approved', 'approved'])
    expect(approved.body.charges).toMatchObject({
      approvedTotalCents: 37500,
      proposedTotalCents: 0,
    })
    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'job.repairs_approved'))
    expect(audit.data).toEqual({
      itemIds: expect.arrayContaining(lines.map((line: { id: string }) => line.id)),
      totalCents: 37500,
      how: 'in_person',
    })

    await jobRepairs.add({ priceItemId: capacitor.id, quantity: 1 }).expect(200)
    const declined = await jobRepairs.decide('declined').expect(200)
    expect(declined.body.charges.lines.at(-1)).toMatchObject({
      status: 'declined',
      removable: false,
    })
    expect(declined.body.charges.approvedTotalCents).toBe(37500)

    const nothing = await jobRepairs.decide('approved').expect(422)
    expect(nothing.body.error.message).toBe('There are no repairs waiting for the homeowner.')
    await jobRepairs.decide('maybe').expect(400)
  })
})

describe('who can change repairs', () => {
  it("refuses another technician's job and office users", async () => {
    const { shop, cookie } = await mikesJob()
    const anas = await createJob(shop, {
      technicianId: shop.ana.id,
      at: `${today()} 08:00`,
      status: 'in_progress',
    })
    const price = await addPrice(shop, 'Thermostat replacement', 21000)

    const res = await repairs(cookie, anas.id)
      .add({ priceItemId: price.id, quantity: 1 })
      .expect(404)
    expect(res.body.error.message).toBe('This job isn’t assigned to you anymore.')
    await repairs(shop.cookie, anas.id).add({ priceItemId: price.id, quantity: 1 }).expect(403)
  })
})

describe('GET /api/my-jobs/price-items', () => {
  it('lists the active prices by name, for technicians only', async () => {
    const { shop, cookie } = await mikesJob()
    const thermostat = await addPrice(shop, 'Thermostat replacement', 21000)
    const capacitor = await addPrice(shop, 'Capacitor replacement', 18500)
    await addPrice(shop, 'Old part', 5000, true)

    const res = await request(app).get('/api/my-jobs/price-items').set('Cookie', cookie).expect(200)

    expect(res.body).toEqual({
      priceItems: [
        { id: capacitor.id, name: 'Capacitor replacement', priceCents: 18500 },
        { id: thermostat.id, name: 'Thermostat replacement', priceCents: 21000 },
      ],
    })
    await request(app).get('/api/my-jobs/price-items').set('Cookie', shop.cookie).expect(403)
  })
})
