import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createJob, createShop, resetDb } from '../../../test/helpers.ts'
import { createApp } from '../../app.ts'
import { db } from '../../db/client.ts'
import { bookingDrafts, bookingPhotos, serviceAreaZips } from '../../db/schema.ts'
import { deleteIdlePhotos } from './online-booking.service.ts'

vi.mock('../../realtime/index.ts', () => ({ emitToTenant: vi.fn() }))

const app = createApp()

beforeEach(async () => {
  await resetDb()
})

// A real 1×1 PNG, and the first bytes that mark a JPEG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00])

// The booking page has no sign-in: the contractor comes from the web address.
function call(method: 'get' | 'post' | 'delete', path: string, slug = 'desert') {
  return request(app)
    [method](`/api/online-booking/${path}`)
    .set('X-Tenant-Host', `${slug}.localhost`)
}

// A contractor serving 85201, and a homeowner who got as far as step 4.
async function startDraft(slug = 'desert') {
  const shop = await createShop(slug)
  await db.insert(serviceAreaZips).values({ tenantId: shop.tenant.id, zip: '85201' })
  const res = await call('post', 'drafts', slug)
    .send({ name: 'Sam Reed', phone: '(480) 555-0199', zip: '85201', consent: false })
    .expect(201)
  return { shop, token: res.body.token as string }
}

function upload(token: string, photo: Buffer, slug = 'desert') {
  return call('post', `drafts/${token}/photos`, slug).set('Content-Type', 'image/jpeg').send(photo)
}

describe('POST /api/online-booking/drafts/:token/photos', () => {
  it('saves a photo the wizard can list and show', async () => {
    const { token } = await startDraft()

    const res = await upload(token, PNG).expect(201)

    const { id, url } = res.body.photo
    expect(url).toBe(`/online-booking/drafts/${token}/photos/${id}`)
    const list = await call('get', `drafts/${token}/photos`).expect(200)
    expect(list.body).toEqual({ photos: [{ id, url }] })

    // An <img> sends no X-Tenant-Host: the token alone finds the photo.
    const image = await request(app).get(`/api${url}`).expect(200)
    expect(image.headers['content-type']).toBe('image/png') // from the bytes, not the upload's claim
    expect(image.headers['x-content-type-options']).toBe('nosniff')
    expect(image.headers['cache-control']).toBe('private, max-age=31536000, immutable')
    expect(Buffer.compare(image.body, PNG)).toBe(0)
  })

  it('takes JPEG, PNG and WebP up to 1 MB, and nothing else', async () => {
    const { token } = await startDraft()

    const notPhoto = await upload(token, Buffer.from('GIF89a')).expect(422)
    expect(notPhoto.body.error).toEqual({
      code: 'not_a_photo',
      message: 'Pick a JPEG, PNG or WebP photo.',
    })

    const atLimit = Buffer.concat([JPEG, Buffer.alloc(1024 * 1024 - JPEG.length)])
    await upload(token, atLimit).expect(201)
    const tooBig = await upload(token, Buffer.concat([atLimit, Buffer.alloc(1)])).expect(413)
    expect(tooBig.body.error).toEqual({
      code: 'photo_too_large',
      message: 'That photo is too large. Pick a smaller one.',
    })
  })

  it('takes at most 3 photos per draft', async () => {
    const { token } = await startDraft()
    for (let i = 0; i < 3; i++) await upload(token, JPEG).expect(201)

    const res = await upload(token, JPEG).expect(409)

    expect(res.body.error).toEqual({
      code: 'too_many_photos',
      message: 'You can add up to 3 photos.',
    })
    expect(await db.select().from(bookingPhotos)).toHaveLength(3)
  })

  it('counts as activity, so the recovery text waits', async () => {
    const { token } = await startDraft()
    const anHourAgo = new Date(Date.now() - 60 * 60_000)
    await db.update(bookingDrafts).set({ lastActivityAt: anHourAgo })

    await upload(token, JPEG).expect(201)

    const [draft] = await db.select().from(bookingDrafts)
    expect(draft.lastActivityAt.getTime()).toBeGreaterThan(anHourAgo.getTime())
  })
})

describe('DELETE /api/online-booking/drafts/:token/photos/:photoId', () => {
  it('removes the photo, and removing it again is fine', async () => {
    const { token } = await startDraft()
    const { body } = await upload(token, JPEG).expect(201)

    await call('delete', `drafts/${token}/photos/${body.photo.id}`).expect(200, { ok: true })
    await call('delete', `drafts/${token}/photos/${body.photo.id}`).expect(200, { ok: true })

    const list = await call('get', `drafts/${token}/photos`).expect(200)
    expect(list.body).toEqual({ photos: [] })
    await request(app).get(`/api${body.photo.url}`).expect(404)
  })
})

describe('draft photos stay private', () => {
  it('hides them from unknown tokens, other contractors and booked drafts', async () => {
    const { shop, token } = await startDraft()
    await startDraft('other')
    const { body } = await upload(token, JPEG).expect(201)
    const { id, url } = body.photo

    await upload('nope', JPEG).expect(404)
    await upload(token, JPEG, 'other').expect(404)
    await call('get', `drafts/${token}/photos`, 'other').expect(404)
    await call('delete', `drafts/${token}/photos/${id}`, 'other').expect(404)
    await request(app).get(`/api/online-booking/drafts/${token}/photos/${randomUUID()}`).expect(404)
    await request(app).get(`/api/online-booking/drafts/${token}/photos/nope`).expect(400)

    // Once booked, the photos belong to the job: the draft's routes no longer show them.
    const job = await createJob(shop)
    await db
      .update(bookingDrafts)
      .set({ bookedJobId: job.id })
      .where(eq(bookingDrafts.token, token))
    await upload(token, JPEG).expect(404)
    await call('get', `drafts/${token}/photos`).expect(404)
    await request(app).get(`/api${url}`).expect(404)
  })
})

// A draft straight in the database, with one photo. Returns the draft's id.
async function insertDraftWithPhoto(
  tenantId: string,
  token: string,
  values: Partial<typeof bookingDrafts.$inferInsert>,
) {
  const [draft] = await db
    .insert(bookingDrafts)
    .values({ tenantId, token, name: 'Sam Reed', phone: '+14805550199', zip: '85201', ...values })
    .returning()
  await db
    .insert(bookingPhotos)
    .values({ tenantId, draftId: draft.id, contentType: 'image/jpeg', data: JPEG })
  return draft.id
}

describe('deleteIdlePhotos', () => {
  it('deletes photos of drafts nobody booked or touched for 30 days, and keeps the rest', async () => {
    const shop = await createShop('desert')
    const job = await createJob(shop)
    const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60_000)
    await insertDraftWithPhoto(shop.tenant.id, 'idle', { lastActivityAt: daysAgo(31) })
    const recent = await insertDraftWithPhoto(shop.tenant.id, 'recent', {
      lastActivityAt: daysAgo(29),
    })
    const booked = await insertDraftWithPhoto(shop.tenant.id, 'booked', {
      lastActivityAt: daysAgo(31),
      bookedJobId: job.id,
    })

    expect(await deleteIdlePhotos()).toBe(1)

    const left = await db.select({ draftId: bookingPhotos.draftId }).from(bookingPhotos)
    expect(left.map((photo) => photo.draftId).sort()).toEqual([recent, booked].sort())
  })
})
