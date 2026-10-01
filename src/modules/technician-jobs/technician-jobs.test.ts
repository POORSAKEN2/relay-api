import { randomUUID } from 'node:crypto'
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
import { bookingDrafts, bookingPhotos } from '../../db/schema.ts'
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

// The first bytes that mark a JPEG.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00])

// A photo the homeowner added while booking `jobId` online: a booked draft with one photo.
async function addBookingPhoto(shop: Shop, jobId: string, token: string) {
  const [draft] = await db
    .insert(bookingDrafts)
    .values({
      tenantId: shop.tenant.id,
      token,
      name: 'Maria Lopez',
      phone: '+16025550111',
      zip: '85004',
      bookedJobId: jobId,
    })
    .returning()
  const [photo] = await db
    .insert(bookingPhotos)
    .values({ tenantId: shop.tenant.id, draftId: draft.id, contentType: 'image/jpeg', data: JPEG })
    .returning()
  return photo
}

const NOT_YOURS = 'This job isn’t assigned to you anymore.'

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
      dateLabel: formatDay(today),
      windowLabel: '8 AM–12 PM',
      etaLabel: null,
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
    expect(res.body).toEqual({ earlier: [], days: [] })
  })

  it('puts unfinished jobs from before today in an Earlier section', async () => {
    const shop = await createShop('desert')
    const mine = { technicianId: shop.mike.id }
    const yesterday = phoenixDay(-1)
    const started = await createJob(shop, {
      ...mine,
      at: `${phoenixDay(-2)} 08:00`,
      status: 'in_progress',
    })
    const booked = await createJob(shop, { ...mine, at: `${yesterday} 08:00` })
    // Not in Earlier: the office reschedules no-access jobs; done is done; Ana's isn't his.
    await createJob(shop, { ...mine, at: `${yesterday} 12:00`, status: 'no_access' })
    await createJob(shop, { ...mine, at: `${yesterday} 12:00`, status: 'done' })
    await createJob(shop, { technicianId: shop.ana.id, at: `${yesterday} 08:00` })

    const res = await request(app)
      .get('/api/my-jobs')
      .set('Cookie', await signInTechnician(shop.mike))
      .expect(200)

    expect(res.body.earlier.map((job: { id: string }) => job.id)).toEqual([started.id, booked.id])
    expect(res.body.earlier[1]).toMatchObject({
      dateLabel: formatDay(yesterday),
      windowLabel: '8 AM–12 PM',
    })
    expect(res.body.days).toEqual([])
  })

  it('shows the arrival time on cards of visits that have not started', async () => {
    const shop = await createShop('desert')
    const today = phoenixDay(0)
    await createJob(shop, {
      technicianId: shop.mike.id,
      at: `${today} 08:00`,
      status: 'en_route',
      etaAt: new Date(`${today}T16:10:00Z`), // 9:10 AM in Phoenix
    })

    const res = await request(app)
      .get('/api/my-jobs')
      .set('Cookie', await signInTechnician(shop.mike))
      .expect(200)

    expect(res.body.days[0].jobs[0].etaLabel).toBe('9:10 AM')
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

describe('GET /api/my-jobs/:jobId', () => {
  it('gives the job page everything for the visit, and nothing office-only', async () => {
    const shop = await createShop('desert')
    const today = phoenixDay(0)
    const job = await createJob(shop, {
      technicianId: shop.mike.id,
      at: `${today} 08:00`,
      vulnerableOccupant: true,
    })
    await request(app)
      .post(`/api/jobs/${job.id}/notes`)
      .set('Cookie', shop.cookie)
      .send({ body: 'Gate code 4321' })
      .expect(201)
    const photo = await addBookingPhoto(shop, job.id, 'token-a')
    const cookie = await signInTechnician(shop.mike)

    const res = await request(app).get(`/api/my-jobs/${job.id}`).set('Cookie', cookie).expect(200)

    expect(res.body.job).toEqual({
      id: job.id,
      status: 'booked',
      priority: false,
      problem: 'AC blowing warm air',
      systemType: 'central_ac',
      vulnerableOccupant: true,
      dateLabel: formatDay(today),
      windowLabel: '8 AM–12 PM',
      etaLabel: null,
      completedLabel: null,
      // The minutes sheet shows arrival times in it, like the homeowner's text.
      timezone: 'America/Phoenix',
      service: { name: 'AC repair' },
      customer: { name: 'Maria Lopez', phone: '+16025550111' },
      property: {
        street: '12 Palm St',
        unit: null,
        city: 'Phoenix',
        state: 'AZ',
        zip: '85004',
        notes: null,
        equipmentBrand: null,
        equipmentYear: null,
      },
    })
    expect(res.body.notes).toEqual([
      expect.objectContaining({ body: 'Gate code 4321', authorName: 'Test office' }),
    ])
    expect(res.body.photos).toEqual([
      { id: photo.id, url: `/my-jobs/${job.id}/photos/${photo.id}` },
    ])

    const image = await request(app).get(`/api${res.body.photos[0].url}`).set('Cookie', cookie)
    expect(image.status).toBe(200)
    expect(image.headers['content-type']).toBe('image/jpeg')
    expect(image.headers['x-content-type-options']).toBe('nosniff')
    expect(Buffer.compare(image.body, JPEG)).toBe(0)
  })

  it("answers the same 404 for any job that isn't this technician's", async () => {
    const shop = await createShop('desert')
    const other = await createShop('other')
    const at = `${phoenixDay(0)} 08:00`
    const anas = await createJob(shop, { technicianId: shop.ana.id, at })
    const unassigned = await createJob(shop, { at })
    const cancelled = await createJob(shop, { technicianId: shop.mike.id, at, status: 'cancelled' })
    const otherShops = await createJob(other, { technicianId: other.mike.id, at })
    const anasPhoto = await addBookingPhoto(shop, anas.id, 'token-b')
    const cookie = await signInTechnician(shop.mike)

    for (const id of [anas.id, unassigned.id, cancelled.id, otherShops.id, randomUUID()]) {
      const res = await request(app).get(`/api/my-jobs/${id}`).set('Cookie', cookie).expect(404)
      expect(res.body.error.message).toBe(NOT_YOURS)
    }
    await request(app)
      .get(`/api/my-jobs/${anas.id}/photos/${anasPhoto.id}`)
      .set('Cookie', cookie)
      .expect(404)
    await request(app).get('/api/my-jobs/nope').set('Cookie', cookie).expect(400)
  })

  it('serves only photos of that job', async () => {
    const shop = await createShop('desert')
    const at = `${phoenixDay(0)} 08:00`
    const job = await createJob(shop, { technicianId: shop.mike.id, at })
    const anas = await createJob(shop, { technicianId: shop.ana.id, at })
    const anasPhoto = await addBookingPhoto(shop, anas.id, 'token-c')

    const res = await request(app)
      .get(`/api/my-jobs/${job.id}/photos/${anasPhoto.id}`)
      .set('Cookie', await signInTechnician(shop.mike))
      .expect(404)
    expect(res.body.error.message).toBe('That photo isn’t on this job.')
  })

  it('is for technicians only, and they still cannot open office job routes', async () => {
    const shop = await createShop('desert')
    const job = await createJob(shop, { technicianId: shop.mike.id, at: `${phoenixDay(0)} 08:00` })
    await request(app).get(`/api/my-jobs/${job.id}`).expect(401)
    await request(app).get(`/api/my-jobs/${job.id}`).set('Cookie', shop.cookie).expect(403)
    await request(app)
      .get(`/api/jobs/${job.id}`)
      .set('Cookie', await signInTechnician(shop.mike))
      .expect(403)
  })
})
