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
import { jobItems, priceItems, properties } from '../../db/schema.ts'

vi.mock('../../realtime/index.ts', () => ({ emitToTenant: vi.fn() }))

const app = createApp()

beforeEach(async () => {
  await resetDb()
})

// A line on a job. A price item makes it a repair; without one it is a booked line.
async function addLine(
  shop: Shop,
  jobId: string,
  line: {
    description: string
    status: 'approved' | 'declined' | 'proposed'
    repair?: boolean
    quantity?: number
  },
) {
  const [price] = line.repair
    ? await db
        .insert(priceItems)
        .values({ tenantId: shop.tenant.id, name: line.description, priceCents: 10000 })
        .returning()
    : [undefined]
  await db.insert(jobItems).values({
    tenantId: shop.tenant.id,
    jobId,
    priceItemId: price?.id ?? null,
    description: line.description,
    quantity: line.quantity ?? 1,
    unitPriceCents: 10000,
    status: line.status,
  })
}

describe('GET /api/my-jobs/:jobId history', () => {
  it('lists finished visits at the same address, newest first, with approved repairs', async () => {
    const shop = await createShop('desert')
    const current = await createJob(shop, { technicianId: shop.mike.id, at: '2030-03-05 08:00' })
    const older = await createJob(shop, {
      technicianId: shop.mike.id,
      status: 'done',
      at: '2030-01-08 08:00',
    })
    const newer = await createJob(shop, {
      technicianId: shop.mike.id,
      status: 'done',
      at: '2030-02-12 08:00',
    })
    await addLine(shop, older.id, { description: 'AC repair (diagnostic fee)', status: 'approved' })
    await addLine(shop, older.id, {
      description: 'Capacitor replacement',
      status: 'approved',
      repair: true,
    })
    await addLine(shop, older.id, {
      description: 'Contactor replacement',
      status: 'approved',
      repair: true,
      quantity: 2,
    })
    await addLine(shop, older.id, { description: 'Fan motor', status: 'declined', repair: true })
    await addLine(shop, older.id, { description: 'Thermostat', status: 'proposed', repair: true })

    const res = await request(app)
      .get(`/api/my-jobs/${current.id}`)
      .set('Cookie', await signInTechnician(shop.mike))
      .expect(200)

    expect(res.body.history).toEqual([
      { id: newer.id, dateLabel: 'Feb 12, 2030', serviceName: 'AC repair', repairs: [] },
      {
        id: older.id,
        dateLabel: 'Jan 8, 2030',
        serviceName: 'AC repair',
        repairs: ['Capacitor replacement', 'Contactor replacement ×2'],
      },
    ])
  })

  it('leaves out unfinished visits, other addresses, other customers and other shops', async () => {
    const shop = await createShop('desert')
    const other = await createShop('other')
    const current = await createJob(shop, { technicianId: shop.mike.id, at: '2030-03-05 08:00' })
    const [elsewhere] = await db
      .insert(properties)
      .values({
        tenantId: shop.tenant.id,
        customerId: shop.customer.id,
        street: '99 Oak Ave',
        city: 'Tempe',
        state: 'AZ',
        zip: '85281',
      })
      .returning()
    const mine = await createJob(shop, {
      technicianId: shop.mike.id,
      status: 'done',
      at: '2030-01-08 08:00',
    })
    await createJob(shop, {
      technicianId: shop.mike.id,
      status: 'cancelled',
      at: '2030-01-09 08:00',
    })
    await createJob(shop, {
      technicianId: shop.mike.id,
      status: 'no_access',
      at: '2030-01-10 08:00',
    })
    await createJob(shop, {
      technicianId: shop.mike.id,
      status: 'done',
      propertyId: elsewhere.id,
      at: '2030-01-11 08:00',
    })
    await createJob(other, { technicianId: other.mike.id, status: 'done', at: '2030-01-12 08:00' })

    const res = await request(app)
      .get(`/api/my-jobs/${current.id}`)
      .set('Cookie', await signInTechnician(shop.mike))
      .expect(200)

    expect(res.body.history.map((visit: { id: string }) => visit.id)).toEqual([mine.id])
  })

  it('is empty on a first visit, and never lists the job itself', async () => {
    const shop = await createShop('desert')
    const job = await createJob(shop, {
      technicianId: shop.mike.id,
      status: 'done',
      at: '2030-03-05 08:00',
    })

    const res = await request(app)
      .get(`/api/my-jobs/${job.id}`)
      .set('Cookie', await signInTechnician(shop.mike))
      .expect(200)

    expect(res.body.history).toEqual([])
  })

  it('shows only the latest 10 visits', async () => {
    const shop = await createShop('desert')
    const current = await createJob(shop, { technicianId: shop.mike.id, at: '2030-06-05 08:00' })
    for (let day = 1; day <= 11; day++) {
      await createJob(shop, {
        technicianId: shop.mike.id,
        status: 'done',
        at: `2030-01-${String(day).padStart(2, '0')} 08:00`,
      })
    }

    const res = await request(app)
      .get(`/api/my-jobs/${current.id}`)
      .set('Cookie', await signInTechnician(shop.mike))
      .expect(200)

    expect(res.body.history).toHaveLength(10)
    expect(res.body.history[0].dateLabel).toBe('Jan 11, 2030')
    expect(res.body.history[9].dateLabel).toBe('Jan 2, 2030')
  })
})
