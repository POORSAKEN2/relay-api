import { eq } from 'drizzle-orm'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createJob,
  createShop,
  createTechnician,
  resetDb,
  signInTechnician,
} from '../../../test/helpers.ts'
import { createApp } from '../../app.ts'
import { db } from '../../db/client.ts'
import {
  auditEvents,
  consentEvents,
  customers,
  jobNotes,
  jobs,
  messages,
  properties,
} from '../../db/schema.ts'
import { formatClock } from '../../lib/labels.ts'
import { emitToTenant } from '../../realtime/index.ts'
import { onMyWayText, runningLateText } from './texts.ts'

vi.mock('../../realtime/index.ts', () => ({ emitToTenant: vi.fn() }))

const app = createApp()
const MINUTE = 60 * 1000
const PHOENIX = 'America/Phoenix'
// createShop names the contractor '<slug> HVAC' and the technician 'Mike'.
const who = { contractorName: 'desert HVAC', technicianName: 'Mike' }

beforeEach(async () => {
  await resetDb()
  vi.mocked(emitToTenant).mockClear()
})

function phoenixDay(offset: number) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: PHOENIX }).format(
    new Date(Date.now() + offset * 24 * 60 * MINUTE),
  )
}

// A job of Mike's today, and his session.
async function mikesJob(values: Parameters<typeof createJob>[1] = {}) {
  const shop = await createShop('desert')
  const job = await createJob(shop, {
    technicianId: shop.mike.id,
    at: `${phoenixDay(0)} 08:00`,
    ...values,
  })
  return { shop, job, cookie: await signInTechnician(shop.mike) }
}

function act(cookie: string, jobId: string, action: string, body: object = {}) {
  return request(app).post(`/api/my-jobs/${jobId}/${action}`).set('Cookie', cookie).send(body)
}

async function savedJob(jobId: string) {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId))
  return job
}

describe('On my way', () => {
  it('marks the job en route with an arrival time and texts the homeowner', async () => {
    const { shop, job, cookie } = await mikesJob()
    // She agreed to texts when the office booked her; without it the text is blocked.
    await db.insert(consentEvents).values({
      tenantId: shop.tenant.id,
      contact: '+16025550111',
      channel: 'sms',
      granted: true,
      source: 'office',
    })
    const before = Date.now()

    const res = await act(cookie, job.id, 'on-my-way', { minutes: 15 }).expect(200)

    const saved = await savedJob(job.id)
    expect(saved.status).toBe('en_route')
    expect(saved.etaAt!.getTime()).toBeGreaterThanOrEqual(before + 15 * MINUTE)
    expect(saved.etaAt!.getTime()).toBeLessThanOrEqual(Date.now() + 15 * MINUTE)
    const arrival = formatClock(saved.etaAt!, PHOENIX)
    expect(res.body.job).toMatchObject({ status: 'en_route', etaLabel: arrival })
    expect(await db.select().from(messages)).toEqual([
      expect.objectContaining({
        kind: 'on_my_way',
        status: 'queued',
        contact: '+16025550111',
        jobId: job.id,
        customerId: shop.customer.id,
        body: onMyWayText(who, arrival),
      }),
    ])
    const audits = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'job.status_changed'))
    expect(audits).toEqual([
      expect.objectContaining({
        actorUserId: shop.mike.id,
        entityId: job.id,
        data: { from: 'booked', to: 'en_route' },
      }),
    ])
    expect(emitToTenant).toHaveBeenCalledWith(shop.tenant.id, 'job.status_changed', {
      jobId: job.id,
      dates: [phoenixDay(0)],
    })
  })

  it('sends no second text for a second tap', async () => {
    const { job, cookie } = await mikesJob()
    await act(cookie, job.id, 'on-my-way', { minutes: 15 }).expect(200)
    await act(cookie, job.id, 'on-my-way', { minutes: 15 }).expect(200)
    expect(await db.select().from(messages)).toHaveLength(1)
  })

  it('still marks the job when the homeowner has no phone, without a text', async () => {
    const { shop, job, cookie } = await mikesJob()
    await db.update(customers).set({ phone: null }).where(eq(customers.id, shop.customer.id))

    await act(cookie, job.id, 'on-my-way', { minutes: 30 }).expect(200)

    expect((await savedJob(job.id)).status).toBe('en_route')
    expect(await db.select().from(messages)).toHaveLength(0)
  })

  it('takes only the offered minutes', async () => {
    const { job, cookie } = await mikesJob()
    const res = await act(cookie, job.id, 'on-my-way', { minutes: 20 }).expect(400)
    expect(res.body.error.details.minutes).toEqual(['Pick how far away you are'])
  })
})

describe('Running late', () => {
  it('moves the arrival time, keeps the status and texts the homeowner', async () => {
    const { shop, job, cookie } = await mikesJob()

    const res = await act(cookie, job.id, 'running-late', { minutes: 30 }).expect(200)

    const saved = await savedJob(job.id)
    expect(saved.status).toBe('booked')
    const arrival = formatClock(saved.etaAt!, PHOENIX)
    expect(res.body.job.etaLabel).toBe(arrival)
    expect(await db.select().from(messages)).toEqual([
      expect.objectContaining({ kind: 'running_late', body: runningLateText(who, arrival) }),
    ])
    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'job.eta_changed'))
    expect(audit).toMatchObject({
      actorUserId: shop.mike.id,
      entityId: job.id,
      data: { minutes: 30, etaAt: saved.etaAt!.toISOString() },
    })
    expect(emitToTenant).toHaveBeenCalledWith(shop.tenant.id, 'job.status_changed', {
      jobId: job.id,
      dates: [phoenixDay(0)],
    })
  })

  it('is refused once the visit has started', async () => {
    const { job, cookie } = await mikesJob({ status: 'in_progress' })
    const res = await act(cookie, job.id, 'running-late', { minutes: 30 }).expect(422)
    expect(res.body.error.message).toBe('This job is in progress, so it can’t be running late.')
    expect(await db.select().from(messages)).toHaveLength(0)
  })
})

describe('Start job and Job complete', () => {
  it('starts and completes the visit without texting the homeowner', async () => {
    const { job, cookie } = await mikesJob({ status: 'en_route', etaAt: new Date() })

    const started = await act(cookie, job.id, 'start').expect(200)
    expect(started.body.job).toMatchObject({ status: 'in_progress', etaLabel: null })
    expect((await savedJob(job.id)).etaAt).toBeNull()

    const done = await act(cookie, job.id, 'complete').expect(200)
    expect(done.body.job.status).toBe('done')
    expect(done.body.job.completedLabel).toMatch(/^\d{1,2}(:\d{2})? (AM|PM)$/)
    expect((await savedJob(job.id)).completedAt).toBeInstanceOf(Date)
    expect(await db.select().from(messages)).toHaveLength(0)
  })

  it('follows the office’s rules', async () => {
    const { job, cookie } = await mikesJob()
    const res = await act(cookie, job.id, 'complete').expect(422)
    expect(res.body.error.message).toBe(
      'This job is booked, so it can’t be marked done. Mark it in progress first.',
    )
  })
})

describe('No access', () => {
  it('saves the note under the technician’s name and texts the homeowner', async () => {
    const { shop, job, cookie } = await mikesJob({ status: 'en_route' })

    const res = await act(cookie, job.id, 'no-access', { note: '  Gate locked, called twice  ' })
    expect(res.status).toBe(200)

    expect((await savedJob(job.id)).status).toBe('no_access')
    expect(await db.select().from(jobNotes)).toEqual([
      expect.objectContaining({
        jobId: job.id,
        authorId: shop.mike.id,
        body: 'Gate locked, called twice',
      }),
    ])
    expect(res.body.notes).toEqual([
      expect.objectContaining({ body: 'Gate locked, called twice', authorName: 'Mike' }),
    ])
    const [text] = await db.select().from(messages)
    expect(text.kind).toBe('no_access')
    expect(text.body).toMatch(
      /^desert HVAC: Mike came by at \d{1,2}(:\d{2})? (AM|PM) but couldn't reach you\. We'll call you to set a new time\.$/,
    )
  })

  it('saves no note when none is written', async () => {
    const { job, cookie } = await mikesJob()
    await act(cookie, job.id, 'no-access').expect(200)
    expect(await db.select().from(jobNotes)).toHaveLength(0)
  })
})

describe('who can tap', () => {
  it('refuses another technician’s job and office users', async () => {
    const { shop, cookie } = await mikesJob()
    const anas = await createJob(shop, { technicianId: shop.ana.id, at: `${phoenixDay(0)} 08:00` })

    for (const action of ['on-my-way', 'running-late', 'start', 'no-access', 'complete']) {
      const res = await act(cookie, anas.id, action, { minutes: 15 }).expect(404)
      expect(res.body.error.message).toBe('This job isn’t assigned to you anymore.')
    }
    await act(shop.cookie, anas.id, 'start').expect(403)
    expect((await savedJob(anas.id)).status).toBe('booked')
  })
})

describe('Technician notes', () => {
  it('saves a note under the technician and answers with the refreshed job', async () => {
    const { shop, job, cookie } = await mikesJob()

    const res = await act(cookie, job.id, 'notes', { body: '  Replaced the capacitor  ' }).expect(
      201,
    )

    expect(res.body.notes).toEqual([
      expect.objectContaining({ body: 'Replaced the capacitor', authorName: 'Mike' }),
    ])
    expect(await db.select().from(jobNotes)).toEqual([
      expect.objectContaining({
        jobId: job.id,
        authorId: shop.mike.id,
        body: 'Replaced the capacitor',
      }),
    ])
    expect(emitToTenant).toHaveBeenCalledWith(shop.tenant.id, 'job.note_added', {
      jobId: job.id,
      dates: [phoenixDay(0)],
    })
  })

  it('needs some text', async () => {
    const { job, cookie } = await mikesJob()
    const res = await act(cookie, job.id, 'notes', { body: '   ' }).expect(400)
    expect(res.body.error.details).toEqual({ body: ['Write a note first'] })
  })

  it('refuses a job that belongs to someone else', async () => {
    const { shop, job } = await mikesJob()
    const other = await createTechnician(shop.tenant.id, 'Sam')
    await act(await signInTechnician(other), job.id, 'notes', { body: 'Hello' }).expect(404)
    expect(await db.select().from(jobNotes)).toHaveLength(0)
  })
})

describe('PATCH /api/my-jobs/:jobId/equipment', () => {
  function setEquipment(cookie: string, jobId: string, body: object) {
    return request(app).patch(`/api/my-jobs/${jobId}/equipment`).set('Cookie', cookie).send(body)
  }

  async function savedProperty(propertyId: string) {
    const [property] = await db.select().from(properties).where(eq(properties.id, propertyId))
    return property
  }

  it('saves the brand and install year on the address and answers with the job page', async () => {
    const { shop, job, cookie } = await mikesJob({ status: 'in_progress' })

    const res = await setEquipment(cookie, job.id, {
      equipmentBrand: ' Carrier ',
      equipmentYear: 2014,
    })

    expect(res.status).toBe(200)
    expect(res.body.job.property).toMatchObject({ equipmentBrand: 'Carrier', equipmentYear: 2014 })
    expect(await savedProperty(shop.property.id)).toMatchObject({
      equipmentBrand: 'Carrier',
      equipmentYear: 2014,
    })
    const events = await db.select().from(auditEvents).where(eq(auditEvents.entityId, job.id))
    expect(events.map((event) => event.action)).toContain('job.equipment_set')
  })

  it('clears a field left blank', async () => {
    const { shop, job, cookie } = await mikesJob({ status: 'in_progress' })
    await setEquipment(cookie, job.id, { equipmentBrand: 'Carrier', equipmentYear: 2014 })

    await setEquipment(cookie, job.id, { equipmentBrand: '', equipmentYear: null })

    expect(await savedProperty(shop.property.id)).toMatchObject({
      equipmentBrand: null,
      equipmentYear: null,
    })
  })

  it('refuses a year that is too old or in the future', async () => {
    const { job, cookie } = await mikesJob({ status: 'in_progress' })

    const old = await setEquipment(cookie, job.id, { equipmentYear: 1900 })
    const future = await setEquipment(cookie, job.id, { equipmentYear: 2999 })

    expect(old.status).toBe(400)
    expect(future.status).toBe(400)
  })

  it('refuses unless the visit is in progress', async () => {
    const { job, cookie } = await mikesJob({ status: 'booked' })

    const res = await setEquipment(cookie, job.id, { equipmentBrand: 'Carrier' })

    expect(res.status).toBe(422)
    expect(res.body.error.message).toBe('This job is booked, so the equipment can’t be changed.')
  })

  it("won't touch another technician's job", async () => {
    const { shop, job } = await mikesJob({ status: 'in_progress' })
    const other = await createTechnician(shop.tenant.id, 'Sam')
    const cookie = await signInTechnician(other)

    const res = await setEquipment(cookie, job.id, { equipmentBrand: 'Carrier' })

    expect(res.status).toBe(404)
    expect((await savedProperty(shop.property.id)).equipmentBrand).toBeNull()
  })
})
