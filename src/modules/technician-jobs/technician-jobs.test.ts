import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createJob, createShop, resetDb, signInTechnician } from '../../../test/helpers.ts'
import { createApp } from '../../app.ts'
import { formatDay } from '../../lib/labels.ts'

vi.mock('../../realtime/index.ts', () => ({ emitToTenant: vi.fn() }))

const app = createApp()

beforeEach(async () => {
  await resetDb()
})

// A local day in Phoenix (the test contractor's time zone), `offset` days from today.
// Phoenix has no daylight saving, so adding whole days is safe.
function phoenixDay(offset: number) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Phoenix' }).format(
    new Date(Date.now() + offset * 24 * 60 * 60 * 1000),
  )
}

describe('GET /api/my-jobs', () => {
  it("lists this technician's jobs for today and the next 6 days, by day", async () => {
    const shop = await createShop('desert')
    const other = await createShop('other')
    const today = phoenixDay(0)
    const mine = { technicianId: shop.mike.id }

    const noon = await createJob(shop, { ...mine, at: `${today} 12:00` })
    const morning = await createJob(shop, { ...mine, at: `${today} 08:00` })
    const priority = await createJob(shop, { ...mine, at: `${today} 08:00`, priority: true })
    const done = await createJob(shop, { ...mine, at: `${today} 08:00`, status: 'done' })
    const tomorrow = await createJob(shop, { ...mine, at: `${phoenixDay(1)} 08:00` })
    const lastDay = await createJob(shop, { ...mine, at: `${phoenixDay(6)} 08:00` })
    // None of these show:
    await createJob(shop, { ...mine, at: `${phoenixDay(7)} 08:00` }) // too far ahead
    await createJob(shop, { ...mine, at: `${phoenixDay(-1)} 08:00` }) // yesterday
    await createJob(shop, { ...mine, at: `${today} 08:00`, status: 'cancelled' })
    await createJob(shop, { technicianId: shop.ana.id, at: `${today} 08:00` }) // Ana's
    await createJob(shop, { at: `${today} 08:00` }) // nobody's yet
    await createJob(other, { technicianId: other.mike.id, at: `${today} 08:00` }) // other shop

    const res = await request(app)
      .get('/api/my-jobs')
      .set('Cookie', await signInTechnician(shop.mike))
      .expect(200)

    const ids = (day: { jobs: { id: string }[] }) => day.jobs.map((job) => job.id)
    expect(res.body.days.map((day: { date: string }) => day.date)).toEqual([
      today,
      phoenixDay(1),
      phoenixDay(6),
    ])
    // By window, PRIORITY first within a window, oldest first, done last.
    expect(ids(res.body.days[0])).toEqual([priority.id, morning.id, noon.id, done.id])
    expect(ids(res.body.days[1])).toEqual([tomorrow.id])
    expect(ids(res.body.days[2])).toEqual([lastDay.id])
    expect(res.body.days[0].label).toBe(formatDay(today))
    expect(res.body.days[0].jobs[0]).toEqual({
      id: priority.id,
      status: 'booked',
      priority: true,
      windowLabel: '8 AM–12 PM',
      customerName: 'Maria Lopez',
      street: '12 Palm St',
      city: 'Phoenix',
      serviceName: 'AC repair',
    })
  })

  it('is empty when nothing is assigned', async () => {
    const shop = await createShop('desert')
    const res = await request(app)
      .get('/api/my-jobs')
      .set('Cookie', await signInTechnician(shop.mike))
      .expect(200)
    expect(res.body).toEqual({ days: [] })
  })

  it('is for technicians only', async () => {
    const shop = await createShop('desert')
    await request(app).get('/api/my-jobs').expect(401)
    await request(app).get('/api/my-jobs').set('Cookie', shop.cookie).expect(403)
    // And technicians still can't open the office's board.
    await request(app)
      .get(`/api/dispatch/board?date=${phoenixDay(0)}`)
      .set('Cookie', await signInTechnician(shop.mike))
      .expect(403)
  })
})
