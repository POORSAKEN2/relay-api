import { eq } from 'drizzle-orm'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createJob, createShop, resetDb, signInTechnician } from '../../../test/helpers.ts'
import { createApp } from '../../app.ts'
import { db } from '../../db/client.ts'
import {
  bookingDrafts,
  bookingPhotos,
  JOB_PHOTO_MAX_BYTES,
  jobPhotos,
  jobs,
  MAX_JOB_PHOTOS_PER_STAGE,
} from '../../db/schema.ts'

vi.mock('../../realtime/index.ts', () => ({ emitToTenant: vi.fn() }))

const app = createApp()

beforeEach(async () => {
  await resetDb()
})

// A real 1×1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

function phoenixDay(offset: number) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Phoenix' }).format(
    new Date(Date.now() + offset * 24 * 60 * 60 * 1000),
  )
}

// Mike's job today with the visit in the given state, and his session.
async function mikesJob(status: (typeof jobs.$inferSelect)['status'] = 'in_progress') {
  const shop = await createShop('desert')
  const job = await createJob(shop, {
    technicianId: shop.mike.id,
    status,
    at: `${phoenixDay(0)} 08:00`,
  })
  return { shop, job, cookie: await signInTechnician(shop.mike) }
}

// The claimed type is ignored: the bytes decide.
function upload(cookie: string, jobId: string, stage: string, photo: Buffer = PNG) {
  return request(app)
    .post(`/api/my-jobs/${jobId}/work-photos/${stage}`)
    .set('Cookie', cookie)
    .set('Content-Type', 'image/jpeg')
    .send(photo)
}

describe('POST /api/my-jobs/:jobId/work-photos/:stage', () => {
  it('saves a before photo and answers with the refreshed job page', async () => {
    const { shop, job, cookie } = await mikesJob()

    const res = await upload(cookie, job.id, 'before').expect(201)

    const [row] = await db.select().from(jobPhotos)
    expect(row).toMatchObject({
      tenantId: shop.tenant.id,
      jobId: job.id,
      stage: 'before',
      uploadedBy: shop.mike.id,
      contentType: 'image/png', // from the bytes, not the upload's claim
    })
    expect(Buffer.compare(row.data, PNG)).toBe(0)
    expect(res.body.workPhotos).toEqual({
      before: [{ id: row.id, url: `/my-jobs/${job.id}/work-photos/${row.id}` }],
      after: [],
    })
    expect(res.body.job.id).toBe(job.id)
  })

  it('keeps before and after apart, oldest first', async () => {
    const { job, cookie } = await mikesJob()

    await upload(cookie, job.id, 'before').expect(201)
    await upload(cookie, job.id, 'after').expect(201)
    const res = await upload(cookie, job.id, 'before').expect(201)

    const rows = await db.select().from(jobPhotos)
    const ids = (stage: string) =>
      rows
        .filter((row) => row.stage === stage)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((row) => row.id)
    expect(res.body.workPhotos.before.map((photo: { id: string }) => photo.id)).toEqual(
      ids('before'),
    )
    expect(res.body.workPhotos.after.map((photo: { id: string }) => photo.id)).toEqual(ids('after'))
    expect(res.body.workPhotos.before).toHaveLength(2)
  })

  it('refuses anything that is not a JPEG, PNG or WebP', async () => {
    const { job, cookie } = await mikesJob()

    const res = await upload(cookie, job.id, 'before', Buffer.from('not a photo')).expect(422)

    expect(res.body.error.code).toBe('not_a_photo')
    expect(res.body.error.message).toBe('Pick a JPEG, PNG or WebP photo.')
    expect(await db.select().from(jobPhotos)).toHaveLength(0)
  })

  it('refuses a photo over 1 MB', async () => {
    const { job, cookie } = await mikesJob()
    const big = Buffer.concat([PNG, Buffer.alloc(JOB_PHOTO_MAX_BYTES)])

    const res = await upload(cookie, job.id, 'after', big).expect(413)

    expect(res.body.error.code).toBe('photo_too_large')
    expect(res.body.error.message).toBe('That photo is too large. Pick a smaller one.')
  })

  it('takes up to 6 photos per stage, and the other stage is not affected', async () => {
    const { job, cookie } = await mikesJob()
    for (let i = 0; i < MAX_JOB_PHOTOS_PER_STAGE; i++) {
      await upload(cookie, job.id, 'before').expect(201)
    }

    const res = await upload(cookie, job.id, 'before').expect(409)

    expect(res.body.error.code).toBe('too_many_photos')
    expect(res.body.error.message).toBe('You can add up to 6 before photos.')
    await upload(cookie, job.id, 'after').expect(201)
  })

  it('does not let two quick uploads both take the last place', async () => {
    const { job, cookie } = await mikesJob()
    for (let i = 0; i < MAX_JOB_PHOTOS_PER_STAGE - 1; i++) {
      await upload(cookie, job.id, 'after').expect(201)
    }

    const results = await Promise.all([
      upload(cookie, job.id, 'after'),
      upload(cookie, job.id, 'after'),
    ])

    expect(results.map((res) => res.status).sort()).toEqual([201, 409])
    expect(await db.select().from(jobPhotos)).toHaveLength(MAX_JOB_PHOTOS_PER_STAGE)
  })

  it('answers 400 for a stage that does not exist', async () => {
    const { job, cookie } = await mikesJob()

    const res = await upload(cookie, job.id, 'middle').expect(400)

    expect(res.body.error.details.stage).toEqual(['That photo stage isn’t valid'])
  })

  it.each(['booked', 'en_route'] as const)(
    'asks to start the visit first when %s',
    async (status) => {
      const { job, cookie } = await mikesJob(status)

      const res = await upload(cookie, job.id, 'before').expect(422)

      expect(res.body.error.code).toBe('photos_not_open')
      expect(res.body.error.message).toBe('Start the visit before adding photos.')
    },
  )

  it.each(['done', 'no_access'] as const)(
    'refuses changes once the visit is %s',
    async (status) => {
      const { job, cookie } = await mikesJob(status)

      const res = await upload(cookie, job.id, 'after').expect(422)

      expect(res.body.error.code).toBe('photos_closed')
      expect(res.body.error.message).toBe('This visit is finished, so its photos can’t change.')
    },
  )

  it('answers 404 for another technician’s job and an unassigned one', async () => {
    const { shop, cookie } = await mikesJob()
    const anas = await createJob(shop, { technicianId: shop.ana.id, status: 'in_progress' })
    const unassigned = await createJob(shop)

    for (const job of [anas, unassigned]) {
      const res = await upload(cookie, job.id, 'before').expect(404)
      expect(res.body.error.message).toBe('This job isn’t assigned to you anymore.')
    }
    expect(await db.select().from(jobPhotos)).toHaveLength(0)
  })

  it('is for technicians only', async () => {
    const { shop, job } = await mikesJob()

    await upload(shop.cookie, job.id, 'before').expect(403)
    await request(app)
      .post(`/api/my-jobs/${job.id}/work-photos/before`)
      .set('Content-Type', 'image/png')
      .send(PNG)
      .expect(401)
  })
})

describe('GET /api/my-jobs/:jobId/work-photos/:photoId', () => {
  it('serves the photo with safe headers', async () => {
    const { job, cookie } = await mikesJob()
    const page = await upload(cookie, job.id, 'before').expect(201)
    const { url } = page.body.workPhotos.before[0]

    const res = await request(app).get(`/api${url}`).set('Cookie', cookie).expect(200)

    expect(res.headers['content-type']).toBe('image/png')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['cache-control']).toBe('private, max-age=31536000, immutable')
    expect(Buffer.compare(res.body, PNG)).toBe(0)
  })

  it('still serves it once the visit is done', async () => {
    const { job, cookie } = await mikesJob()
    const page = await upload(cookie, job.id, 'after').expect(201)
    const { url } = page.body.workPhotos.after[0]
    await db.update(jobs).set({ status: 'done' })

    await request(app).get(`/api${url}`).set('Cookie', cookie).expect(200)
  })

  it('answers 404 for a photo that belongs to another job', async () => {
    const { shop, job, cookie } = await mikesJob()
    const other = await createJob(shop, { technicianId: shop.mike.id, status: 'in_progress' })
    const page = await upload(cookie, other.id, 'before').expect(201)
    const photoId = page.body.workPhotos.before[0].id

    const res = await request(app)
      .get(`/api/my-jobs/${job.id}/work-photos/${photoId}`)
      .set('Cookie', cookie)
      .expect(404)

    expect(res.body.error.message).toBe('That photo isn’t on this job.')
  })

  it('answers 400 for a photo id that is not an id', async () => {
    const { job, cookie } = await mikesJob()

    await request(app)
      .get(`/api/my-jobs/${job.id}/work-photos/nope`)
      .set('Cookie', cookie)
      .expect(400)
  })
})

describe('DELETE /api/my-jobs/:jobId/work-photos/:photoId', () => {
  it('removes a photo and answers with the refreshed job page', async () => {
    const { job, cookie } = await mikesJob()
    const page = await upload(cookie, job.id, 'before').expect(201)
    const photoId = page.body.workPhotos.before[0].id

    const res = await request(app)
      .delete(`/api/my-jobs/${job.id}/work-photos/${photoId}`)
      .set('Cookie', cookie)
      .expect(200)

    expect(res.body.workPhotos).toEqual({ before: [], after: [] })
    expect(await db.select().from(jobPhotos)).toHaveLength(0)
  })

  it('is harmless when the photo is already gone', async () => {
    const { job, cookie } = await mikesJob()
    const page = await upload(cookie, job.id, 'before').expect(201)
    const photoId = page.body.workPhotos.before[0].id
    const remove = () =>
      request(app).delete(`/api/my-jobs/${job.id}/work-photos/${photoId}`).set('Cookie', cookie)

    await remove().expect(200)
    await remove().expect(200)
  })

  it('does not remove a photo of another job', async () => {
    const { shop, job, cookie } = await mikesJob()
    const other = await createJob(shop, { technicianId: shop.mike.id, status: 'in_progress' })
    const page = await upload(cookie, other.id, 'before').expect(201)
    const photoId = page.body.workPhotos.before[0].id

    await request(app)
      .delete(`/api/my-jobs/${job.id}/work-photos/${photoId}`)
      .set('Cookie', cookie)
      .expect(200) // nothing on this job matches, so nothing goes

    expect(await db.select().from(jobPhotos).where(eq(jobPhotos.id, photoId))).toHaveLength(1)
  })

  it('refuses once the visit is done', async () => {
    const { job, cookie } = await mikesJob()
    const page = await upload(cookie, job.id, 'after').expect(201)
    const photoId = page.body.workPhotos.after[0].id
    await db.update(jobs).set({ status: 'done' })

    const res = await request(app)
      .delete(`/api/my-jobs/${job.id}/work-photos/${photoId}`)
      .set('Cookie', cookie)
      .expect(422)

    expect(res.body.error.code).toBe('photos_closed')
    expect(await db.select().from(jobPhotos)).toHaveLength(1)
  })
})

describe('the homeowner’s booking photos', () => {
  it('stay in photos, apart from the technician’s own', async () => {
    const { shop, job, cookie } = await mikesJob()
    const [draft] = await db
      .insert(bookingDrafts)
      .values({
        tenantId: shop.tenant.id,
        token: 'token-a',
        name: 'Maria Lopez',
        phone: '+16025550111',
        zip: '85004',
        bookedJobId: job.id,
      })
      .returning()
    const [booking] = await db
      .insert(bookingPhotos)
      .values({ tenantId: shop.tenant.id, draftId: draft.id, contentType: 'image/png', data: PNG })
      .returning()
    await upload(cookie, job.id, 'before').expect(201)

    const res = await request(app).get(`/api/my-jobs/${job.id}`).set('Cookie', cookie).expect(200)

    expect(res.body.photos).toEqual([
      { id: booking.id, url: `/my-jobs/${job.id}/photos/${booking.id}` },
    ])
    expect(res.body.workPhotos.before).toHaveLength(1)
    expect(res.body.workPhotos.after).toEqual([])
  })
})
