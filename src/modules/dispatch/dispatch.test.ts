import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createJob,
  createShop,
  createTechnician,
  createUser,
  resetDb,
  type Shop,
  signIn,
  TUESDAY,
  WEDNESDAY,
} from '../../../test/helpers.ts'
import { createApp } from '../../app.ts'
import { db } from '../../db/client.ts'
import { auditEvents, bookingDrafts, bookingPhotos, jobs, users } from '../../db/schema.ts'
import { emitToTenant } from '../../realtime/index.ts'

vi.mock('../../realtime/index.ts', () => ({ emitToTenant: vi.fn() }))

const app = createApp()

// The first bytes that mark a JPEG.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00])

// A photo the homeowner added while booking `jobId` online: a booked draft with one photo.
async function addBookingPhoto(shop: Shop, jobId: string, token: string) {
  const [draft] = await db
    .insert(bookingDrafts)
    .values({
      tenantId: shop.tenant.id,
      token,
      name: 'Sam Reed',
      phone: '+14805550199',
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

beforeEach(async () => {
  await resetDb()
  vi.mocked(emitToTenant).mockClear()
})

describe('GET /api/dispatch/board', () => {
  it("lays out one local day: windows with booked counts, technicians, and that day's jobs", async () => {
    const shop = await createShop('desert')
    const morning = await createJob(shop, { technicianId: shop.mike.id, priority: true })
    await createJob(shop, { status: 'cancelled' })
    const afternoon = await createJob(shop, { at: `${TUESDAY} 12:00` })
    const odd = await createJob(shop, { at: `${TUESDAY} 17:00`, hours: 2 })
    await createJob(shop, { at: `${WEDNESDAY} 08:00` })
    await createTechnician(shop.tenant.id, 'Zed').then((zed) =>
      db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, zed.id)),
    )
    const other = await createShop('other')
    await createJob(other)

    const res = await request(app)
      .get(`/api/dispatch/board?date=${TUESDAY}`)
      .set('Cookie', shop.cookie)
      .expect(200)

    expect(res.body.date).toBe(TUESDAY)
    expect(res.body.label).toBe('Tue, Jan 8')
    expect(res.body.windows).toEqual([
      {
        id: shop.tueMorning.id,
        label: '8 AM–12 PM',
        jobCap: 2,
        booked: 1,
      },
      {
        id: shop.tueAfternoon.id,
        label: '12 PM–4 PM',
        jobCap: 2,
        booked: 1,
      },
    ])
    expect(res.body.technicians).toEqual([
      { id: shop.ana.id, name: 'Ana' },
      { id: shop.mike.id, name: 'Mike' },
    ])
    expect(res.body.jobs).toEqual([
      {
        id: morning.id,
        status: 'booked',
        priority: true,
        source: 'office',
        technicianId: shop.mike.id,
        windowId: shop.tueMorning.id,
        windowLabel: '8 AM–12 PM',
        etaLabel: null,
        customerName: 'Maria Lopez',
        city: 'Phoenix',
        serviceName: 'AC repair',
        problem: 'AC blowing warm air',
      },
      expect.objectContaining({ id: afternoon.id, windowId: shop.tueAfternoon.id }),
      // Its time matches no current window, so it goes in the "Other times" row.
      expect.objectContaining({ id: odd.id, windowId: null, windowLabel: '5 PM–7 PM' }),
    ])
  })

  it('needs a valid date', async () => {
    const shop = await createShop('desert')
    const res = await request(app)
      .get('/api/dispatch/board?date=tomorrow')
      .set('Cookie', shop.cookie)
      .expect(400)
    expect(res.body.error.details).toEqual({ date: ['Pick a date'] })
  })

  it('is for owner and office staff only', async () => {
    const shop = await createShop('desert')
    const tech = await createUser('technician', shop.tenant.id)
    await request(app).get(`/api/dispatch/board?date=${TUESDAY}`).expect(401)
    await request(app)
      .get(`/api/dispatch/board?date=${TUESDAY}`)
      .set('Cookie', await signIn(tech.email))
      .expect(403)
  })
})

describe('GET /api/jobs/:jobId', () => {
  it('returns everything the job drawer shows', async () => {
    const shop = await createShop('desert')
    const job = await createJob(shop, { technicianId: shop.ana.id, vulnerableOccupant: true })
    await request(app)
      .post(`/api/jobs/${job.id}/notes`)
      .set('Cookie', shop.cookie)
      .send({ body: 'Gate code 4321' })
      .expect(201)

    const res = await request(app).get(`/api/jobs/${job.id}`).set('Cookie', shop.cookie).expect(200)
    expect(res.body.job).toMatchObject({
      id: job.id,
      status: 'booked',
      date: TUESDAY,
      dateLabel: 'Tue, Jan 8',
      windowId: shop.tueMorning.id,
      windowLabel: '8 AM–12 PM',
      problem: 'AC blowing warm air',
      systemType: 'central_ac',
      vulnerableOccupant: true,
      technician: { id: shop.ana.id, name: 'Ana' },
      service: { id: shop.service.id, name: 'AC repair' },
      customer: { id: shop.customer.id, name: 'Maria Lopez', phone: '+16025550111', email: null },
      property: { street: '12 Palm St', city: 'Phoenix', state: 'AZ', zip: '85004' },
      allowedStatuses: ['en_route', 'in_progress', 'no_access', 'cancelled'],
    })
    expect(res.body.notes).toEqual([
      expect.objectContaining({ body: 'Gate code 4321', authorName: 'Test office' }),
    ])
    expect(res.body.photos).toEqual([]) // booked by the office: no homeowner photos
  })

  it("404s for another contractor's job", async () => {
    const shop = await createShop('desert')
    const other = await createShop('other')
    const job = await createJob(other)
    const res = await request(app).get(`/api/jobs/${job.id}`).set('Cookie', shop.cookie).expect(404)
    expect(res.body.error.message).toBe(
      'This job isn’t on the board anymore. It may have been cancelled.',
    )
  })

  it("shows the homeowner's booking photos to staff only", async () => {
    const shop = await createShop('desert')
    const job = await createJob(shop)
    const otherJob = await createJob(shop, { at: `${TUESDAY} 12:00` })
    const photo = await addBookingPhoto(shop, job.id, 'token-a')
    const otherPhoto = await addBookingPhoto(shop, otherJob.id, 'token-b')

    const res = await request(app).get(`/api/jobs/${job.id}`).set('Cookie', shop.cookie).expect(200)
    expect(res.body.photos).toEqual([{ id: photo.id, url: `/jobs/${job.id}/photos/${photo.id}` }])

    const image = await request(app)
      .get(`/api${res.body.photos[0].url}`)
      .set('Cookie', shop.cookie)
      .expect(200)
    expect(image.headers['content-type']).toBe('image/jpeg')
    expect(image.headers['x-content-type-options']).toBe('nosniff')
    expect(Buffer.compare(image.body, JPEG)).toBe(0)

    const wrongJob = await request(app)
      .get(`/api/jobs/${job.id}/photos/${otherPhoto.id}`)
      .set('Cookie', shop.cookie)
      .expect(404)
    expect(wrongJob.body.error.message).toBe('That photo isn’t on this job.')
    await request(app).get(`/api/jobs/${job.id}/photos/${photo.id}`).expect(401)
  })
})

describe('PUT /api/jobs/:jobId/slot', () => {
  it('assigns a technician without touching the window', async () => {
    const shop = await createShop('desert')
    const job = await createJob(shop)
    // The window is over its cap, but assigning inside it must still work.
    await createJob(shop)
    await createJob(shop)

    const res = await request(app)
      .put(`/api/jobs/${job.id}/slot`)
      .set('Cookie', shop.cookie)
      .send({ date: TUESDAY, windowId: shop.tueMorning.id, technicianId: shop.mike.id })
      .expect(200)
    expect(res.body).toEqual({ jobId: job.id, dates: [TUESDAY] })

    const [saved] = await db.select().from(jobs).where(eq(jobs.id, job.id))
    expect(saved.technicianId).toBe(shop.mike.id)
    expect(emitToTenant).toHaveBeenCalledWith(shop.tenant.id, 'job.assigned', {
      jobId: job.id,
      dates: [TUESDAY],
    })
    const audit = await db.select().from(auditEvents)
    expect(audit.map((event) => event.action)).toEqual(['job.assigned'])
  })

  it('moves a job to another day and unassigns it, refreshing both days', async () => {
    const shop = await createShop('desert')
    const job = await createJob(shop, { technicianId: shop.mike.id, status: 'no_access' })

    const res = await request(app)
      .put(`/api/jobs/${job.id}/slot`)
      .set('Cookie', shop.cookie)
      .send({ date: WEDNESDAY, windowId: shop.wedMorning.id, technicianId: null })
      .expect(200)
    expect(res.body.dates).toEqual([TUESDAY, WEDNESDAY])

    const [saved] = await db.select().from(jobs).where(eq(jobs.id, job.id))
    expect(saved).toMatchObject({
      technicianId: null,
      status: 'booked', // a no-access visit goes back to booked once it has a new time
      windowStartsAt: new Date('2030-01-09T15:00:00Z'),
      windowEndsAt: new Date('2030-01-09T19:00:00Z'),
    })
    const audit = await db.select().from(auditEvents)
    expect(audit.map((event) => event.action).sort()).toEqual(['job.assigned', 'job.moved'])
  })

  it('warns before moving into a full window', async () => {
    const shop = await createShop('desert')
    const job = await createJob(shop, { at: `${TUESDAY} 12:00` })
    await createJob(shop)
    await createJob(shop)
    const move = { date: TUESDAY, windowId: shop.tueMorning.id, technicianId: null }

    const full = await request(app)
      .put(`/api/jobs/${job.id}/slot`)
      .set('Cookie', shop.cookie)
      .send(move)
      .expect(409)
    expect(full.body.error.message).toBe(
      'The 8 AM–12 PM window on Tue, Jan 8 is full (2 of 2 booked).',
    )

    await request(app)
      .put(`/api/jobs/${job.id}/slot`)
      .set('Cookie', shop.cookie)
      .send({ ...move, allowOverCap: true })
      .expect(200)
  })

  it("refuses another contractor's technician, or a disabled one", async () => {
    const shop = await createShop('desert')
    const other = await createShop('other')
    const job = await createJob(shop)
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, shop.ana.id))

    for (const technicianId of [other.mike.id, shop.ana.id, shop.office.id]) {
      const res = await request(app)
        .put(`/api/jobs/${job.id}/slot`)
        .set('Cookie', shop.cookie)
        .send({ date: TUESDAY, windowId: shop.tueMorning.id, technicianId })
        .expect(422)
      expect(res.body.error.message).toBe('That technician isn’t available. Pick another one.')
    }
  })

  it("won't move a job that is under way or closed", async () => {
    const shop = await createShop('desert')
    const job = await createJob(shop, { technicianId: shop.mike.id, status: 'in_progress' })

    const res = await request(app)
      .put(`/api/jobs/${job.id}/slot`)
      .set('Cookie', shop.cookie)
      .send({ date: WEDNESDAY, windowId: shop.wedMorning.id, technicianId: shop.mike.id })
      .expect(422)
    expect(res.body.error.message).toBe('This job is in progress, so it can’t be moved.')
  })
})

describe('POST /api/jobs/:jobId/status', () => {
  async function setStatus(from: string, to: string, technician = true) {
    const shop = await createShop(`s${randomUUID().slice(0, 8)}`)
    const job = await createJob(shop, {
      status: from as 'booked',
      technicianId: technician ? shop.mike.id : null,
    })
    const res = await request(app)
      .post(`/api/jobs/${job.id}/status`)
      .set('Cookie', shop.cookie)
      .send({ status: to })
    const [saved] = await db.select().from(jobs).where(eq(jobs.id, job.id))
    return { res, saved, shop, job }
  }

  it.each([
    ['booked', 'en_route'],
    ['booked', 'in_progress'],
    ['booked', 'no_access'],
    ['booked', 'cancelled'],
    ['en_route', 'in_progress'],
    ['en_route', 'no_access'],
    ['en_route', 'cancelled'],
    ['in_progress', 'done'],
    ['in_progress', 'cancelled'],
    ['no_access', 'booked'],
    ['no_access', 'cancelled'],
  ])('allows %s → %s', async (from, to) => {
    const { res, saved } = await setStatus(from, to)
    expect(res.status).toBe(200)
    expect(saved.status).toBe(to)
  })

  it.each([
    [
      'booked',
      'done',
      'This job is booked, so it can’t be marked done. Mark it in progress first.',
    ],
    ['en_route', 'booked', 'This job is en route, so it can’t be marked booked.'],
    ['done', 'cancelled', 'This job is already done, so its status can’t change.'],
    ['cancelled', 'booked', 'This job is already cancelled, so its status can’t change.'],
  ])('refuses %s → %s', async (from, to, message) => {
    const { res, saved } = await setStatus(from, to)
    expect(res.status).toBe(422)
    expect(res.body.error).toEqual({ code: 'invalid_transition', message })
    expect(saved.status).toBe(from)
  })

  it('needs a technician before the visit starts', async () => {
    const { res } = await setStatus('booked', 'en_route', false)
    expect(res.status).toBe(422)
    expect(res.body.error).toEqual({
      code: 'technician_required',
      message: 'Assign a technician before marking this job en route.',
    })
  })

  it('stamps completion, logs it, and tells the office', async () => {
    const { res, saved, shop, job } = await setStatus('in_progress', 'done')
    expect(res.body).toEqual({ jobId: job.id, dates: [TUESDAY] })
    expect(saved.completedAt).toBeInstanceOf(Date)
    const [audit] = await db.select().from(auditEvents)
    expect(audit).toMatchObject({
      action: 'job.status_changed',
      data: { from: 'in_progress', to: 'done' },
    })
    expect(emitToTenant).toHaveBeenCalledWith(shop.tenant.id, 'job.status_changed', {
      jobId: job.id,
      dates: [TUESDAY],
    })
  })

  it('treats a repeat of the current status as done already', async () => {
    const { res } = await setStatus('en_route', 'en_route')
    expect(res.status).toBe(200)
    expect(emitToTenant).not.toHaveBeenCalled()
  })
})

describe('POST /api/jobs/:jobId/notes', () => {
  it('needs some text', async () => {
    const shop = await createShop('desert')
    const job = await createJob(shop)
    const res = await request(app)
      .post(`/api/jobs/${job.id}/notes`)
      .set('Cookie', shop.cookie)
      .send({ body: '   ' })
      .expect(400)
    expect(res.body.error.details).toEqual({ body: ['Write a note first'] })
  })
})

describe('arrival times', () => {
  // 9:10 AM in Phoenix on TUESDAY.
  const nineTen = new Date(`${TUESDAY}T16:10:00Z`)

  it('shows the arrival time on the board and in the drawer until the visit starts', async () => {
    const shop = await createShop('desert')
    const mine = { technicianId: shop.mike.id, etaAt: nineTen }
    const enRoute = await createJob(shop, { ...mine, status: 'en_route' })
    const late = await createJob(shop, mine) // booked, after "Running late"
    const started = await createJob(shop, { ...mine, status: 'in_progress' })
    const noTime = await createJob(shop)

    const board = await request(app)
      .get(`/api/dispatch/board?date=${TUESDAY}`)
      .set('Cookie', shop.cookie)
      .expect(200)
    const etaOf = (id: string) =>
      board.body.jobs.find((job: { id: string }) => job.id === id).etaLabel
    expect(etaOf(enRoute.id)).toBe('9:10 AM')
    expect(etaOf(late.id)).toBe('9:10 AM')
    expect(etaOf(started.id)).toBeNull()
    expect(etaOf(noTime.id)).toBeNull()

    const drawer = await request(app)
      .get(`/api/jobs/${enRoute.id}`)
      .set('Cookie', shop.cookie)
      .expect(200)
    expect(drawer.body.job.etaLabel).toBe('9:10 AM')
    expect(drawer.body.job.completedLabel).toBeNull()
  })

  it('forgets the arrival time when the office changes the status or moves the job', async () => {
    const shop = await createShop('desert')
    const statusChanged = await createJob(shop, { technicianId: shop.mike.id, etaAt: nineTen })
    const moved = await createJob(shop, { technicianId: shop.mike.id, etaAt: nineTen })

    await request(app)
      .post(`/api/jobs/${statusChanged.id}/status`)
      .set('Cookie', shop.cookie)
      .send({ status: 'en_route' })
      .expect(200)
    await request(app)
      .put(`/api/jobs/${moved.id}/slot`)
      .set('Cookie', shop.cookie)
      .send({ date: TUESDAY, windowId: shop.tueAfternoon.id, technicianId: shop.mike.id })
      .expect(200)

    const saved = await db.select({ id: jobs.id, etaAt: jobs.etaAt }).from(jobs)
    expect(saved.find((job) => job.id === statusChanged.id)?.etaAt).toBeNull()
    expect(saved.find((job) => job.id === moved.id)?.etaAt).toBeNull()
  })
})
