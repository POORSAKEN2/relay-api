import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createJob,
  createShop,
  createUser,
  resetDb,
  type Shop,
  signIn,
  TUESDAY,
  WEDNESDAY,
} from '../../../test/helpers.ts'
import { createApp } from '../../app.ts'
import { db } from '../../db/client.ts'
import { auditEvents, jobs, sessions, users } from '../../db/schema.ts'
import { emitToTenant } from '../../realtime/index.ts'

vi.mock('../../realtime/index.ts', () => ({ emitToTenant: vi.fn() }))

const app = createApp()

// The details every new technician needs besides name and phone.
const PROFILE = {
  address: '12 Palm St, Phoenix, AZ 85004',
  emergencyContactName: 'Dana Torres',
  emergencyContactPhone: '(602) 555-0188',
}
const PROFILE_SAVED = {
  address: '12 Palm St, Phoenix, AZ 85004',
  emergencyContactName: 'Dana Torres',
  emergencyContactPhone: '+16025550188',
  photoUrl: null,
}

beforeEach(async () => {
  await resetDb()
  vi.mocked(emitToTenant).mockClear()
})

function addTechnician(shop: Shop, body: Record<string, unknown>) {
  return request(app).post('/api/technicians').set('Cookie', shop.cookie).send(body)
}

describe('GET /api/technicians', () => {
  it("lists the contractor's technicians, active first, with their upcoming jobs", async () => {
    const shop = await createShop('desert')
    await createJob(shop, { technicianId: shop.mike.id })
    await createJob(shop, {
      technicianId: shop.mike.id,
      status: 'no_access',
      at: `${WEDNESDAY} 08:00`,
    })
    await createJob(shop, { technicianId: shop.mike.id, status: 'done' })
    await createJob(shop, { technicianId: shop.mike.id, at: '2020-01-07 08:00' })
    const [zed] = await db
      .insert(users)
      .values({
        tenantId: shop.tenant.id,
        role: 'technician',
        name: 'Zed',
        phone: '+14805550999',
        address: '9 Zed Rd, Phoenix, AZ 85004',
        emergencyContactName: 'Zed Contact',
        emergencyContactPhone: '+14805550100',
        disabledAt: new Date(),
      })
      .returning()
    const other = await createShop('other')

    const res = await request(app).get('/api/technicians').set('Cookie', shop.cookie).expect(200)

    expect(res.body.technicians).toEqual([
      {
        id: shop.ana.id,
        name: 'Ana',
        phone: shop.ana.phone,
        email: null,
        photoUrl: null,
        address: '1 Test St, Phoenix, AZ 85004',
        emergencyContactName: 'Test Contact',
        emergencyContactPhone: '+14805550100',
        active: true,
        upcomingJobs: 0,
      },
      {
        id: shop.mike.id,
        name: 'Mike',
        phone: shop.mike.phone,
        email: null,
        photoUrl: null,
        address: '1 Test St, Phoenix, AZ 85004',
        emergencyContactName: 'Test Contact',
        emergencyContactPhone: '+14805550100',
        active: true,
        upcomingJobs: 2, // booked and no-access from today on; not done, not past
      },
      {
        id: zed.id,
        name: 'Zed',
        phone: '+14805550999',
        email: null,
        photoUrl: null,
        address: '9 Zed Rd, Phoenix, AZ 85004',
        emergencyContactName: 'Zed Contact',
        emergencyContactPhone: '+14805550100',
        active: false,
        upcomingJobs: 0,
      },
    ])
    expect(JSON.stringify(res.body)).not.toContain(other.mike.id)
    expect(JSON.stringify(res.body)).not.toContain(shop.office.id)
  })

  it('is for owner and office staff only', async () => {
    const shop = await createShop('desert')
    const owner = await createUser('owner', shop.tenant.id)
    const tech = await createUser('technician', shop.tenant.id)
    const admin = await createUser('superadmin', null)

    await request(app).get('/api/technicians').expect(401)
    for (const email of [tech.email, admin.email]) {
      await request(app)
        .get('/api/technicians')
        .set('Cookie', await signIn(email))
        .expect(403)
    }
    await request(app)
      .get('/api/technicians')
      .set('Cookie', await signIn(owner.email))
      .expect(200)
  })
})

describe('POST /api/technicians', () => {
  it('adds a technician to the team and tells open dashboards', async () => {
    const shop = await createShop('desert')

    const res = await addTechnician(shop, {
      name: '  Luis Moreno ',
      phone: '(480) 555-0303',
      email: 'Luis@Example.com',
      ...PROFILE,
      photoUrl: 'https://cdn.example.com/luis.jpg',
    }).expect(201)

    expect(res.body.technician).toEqual({
      id: expect.any(String),
      name: 'Luis Moreno',
      phone: '+14805550303',
      email: 'luis@example.com',
      ...PROFILE_SAVED,
      photoUrl: 'https://cdn.example.com/luis.jpg',
      active: true,
      upcomingJobs: 0,
    })
    const [saved] = await db.select().from(users).where(eq(users.id, res.body.technician.id))
    expect(saved).toMatchObject({
      tenantId: shop.tenant.id,
      role: 'technician',
      passwordHash: null,
    })

    const [audit] = await db.select().from(auditEvents)
    expect(audit).toMatchObject({ action: 'user.created', entityId: saved.id })
    expect(emitToTenant).toHaveBeenCalledWith(shop.tenant.id, 'team.updated', {
      tenantId: shop.tenant.id,
    })

    const board = await request(app)
      .get(`/api/dispatch/board?date=${TUESDAY}`)
      .set('Cookie', shop.cookie)
      .expect(200)
    expect(board.body.technicians.map((t: { name: string }) => t.name)).toContain('Luis Moreno')
  })

  it('explains bad input field by field', async () => {
    const shop = await createShop('desert')

    const res = await addTechnician(shop, {
      name: '',
      phone: '555',
      email: 'nope',
      address: ' ',
      emergencyContactName: '',
      emergencyContactPhone: '12',
      photoUrl: 'not a link',
    }).expect(400)
    expect(res.body.error.details).toEqual({
      name: ['Enter the technician’s name'],
      phone: ['Enter a 10-digit phone number'],
      email: ['Enter a valid email address'],
      address: ['Enter the technician’s address'],
      emergencyContactName: ['Enter an emergency contact name'],
      emergencyContactPhone: ['Enter a 10-digit phone number'],
      photoUrl: ['Enter a valid image link'],
    })
  })

  it('treats a blank email as no email', async () => {
    const shop = await createShop('desert')
    const res = await addTechnician(shop, {
      name: 'Luis',
      phone: '4805550303',
      email: '',
      ...PROFILE,
    })
    expect(res.status).toBe(201)
    expect(res.body.technician.email).toBeNull()
  })

  it('needs an address and emergency contact, but not a photo', async () => {
    const shop = await createShop('desert')
    const res = await addTechnician(shop, { name: 'Luis', phone: '4805550303' }).expect(400)
    expect(Object.keys(res.body.error.details).sort()).toEqual([
      'address',
      'emergencyContactName',
      'emergencyContactPhone',
    ])
    const ok = await addTechnician(shop, { name: 'Luis', phone: '4805550303', ...PROFILE })
    expect(ok.status).toBe(201)
    expect(ok.body.technician.photoUrl).toBeNull()
  })

  it('refuses a phone number or email another account already uses', async () => {
    const shop = await createShop('desert')
    const other = await createShop('other')
    const office = await createUser('office', shop.tenant.id)

    const phone = await addTechnician(shop, {
      name: 'Luis',
      phone: other.mike.phone,
      ...PROFILE,
    }).expect(409)
    expect(phone.body.error).toEqual({
      code: 'phone_taken',
      message: 'That phone number is already used by another account.',
    })

    const email = await addTechnician(shop, {
      name: 'Luis',
      phone: '4805550303',
      email: office.email,
      ...PROFILE,
    }).expect(409)
    expect(email.body.error).toEqual({
      code: 'email_taken',
      message: 'That email is already used by another account.',
    })
  })
})

describe('PATCH /api/technicians/:technicianId', () => {
  it('updates name, phone and email', async () => {
    const shop = await createShop('desert')

    const res = await request(app)
      .patch(`/api/technicians/${shop.mike.id}`)
      .set('Cookie', shop.cookie)
      .send({
        name: 'Mike Torres',
        phone: '602-555-0404',
        email: 'mike@desert.test',
        ...PROFILE,
      })
      .expect(200)

    expect(res.body.technician).toMatchObject({
      name: 'Mike Torres',
      phone: '+16025550404',
      email: 'mike@desert.test',
      ...PROFILE_SAVED,
    })
    const [audit] = await db.select().from(auditEvents)
    expect(audit).toMatchObject({ action: 'user.updated', entityId: shop.mike.id })
    expect(emitToTenant).toHaveBeenCalledWith(shop.tenant.id, 'team.updated', {
      tenantId: shop.tenant.id,
    })
  })

  it("only edits this contractor's technicians", async () => {
    const shop = await createShop('desert')
    const other = await createShop('other')

    for (const id of [other.mike.id, shop.office.id, randomUUID()]) {
      const res = await request(app)
        .patch(`/api/technicians/${id}`)
        .set('Cookie', shop.cookie)
        .send({ name: 'Hijacked', phone: '4805550303', ...PROFILE })
        .expect(404)
      expect(res.body.error.message).toBe('That technician isn’t on your team.')
    }
  })

  it('refuses a phone number another account uses', async () => {
    const shop = await createShop('desert')
    const res = await request(app)
      .patch(`/api/technicians/${shop.mike.id}`)
      .set('Cookie', shop.cookie)
      .send({ name: 'Mike', phone: shop.ana.phone, ...PROFILE })
      .expect(409)
    expect(res.body.error.code).toBe('phone_taken')
  })
})

describe('POST /api/technicians/:technicianId/deactivate', () => {
  it('moves their open jobs from today on to Unassigned and signs them out', async () => {
    const shop = await createShop('desert')
    const booked = await createJob(shop, { technicianId: shop.mike.id })
    const noAccess = await createJob(shop, {
      technicianId: shop.mike.id,
      status: 'no_access',
      at: `${WEDNESDAY} 08:00`,
    })
    const enRoute = await createJob(shop, { technicianId: shop.mike.id, status: 'en_route' })
    const past = await createJob(shop, { technicianId: shop.mike.id, at: '2020-01-07 08:00' })
    const anas = await createJob(shop, { technicianId: shop.ana.id })
    await db.insert(sessions).values({
      id: 'a'.repeat(64),
      userId: shop.mike.id,
      expiresAt: new Date(Date.now() + 86_400_000),
    })

    const res = await request(app)
      .post(`/api/technicians/${shop.mike.id}/deactivate`)
      .set('Cookie', shop.cookie)
      .expect(200)

    expect(res.body).toEqual({
      technician: expect.objectContaining({ id: shop.mike.id, active: false, upcomingJobs: 0 }),
      unassignedJobs: 2,
      dates: [TUESDAY, WEDNESDAY],
    })
    const technicianOf = async (jobId: string) =>
      (await db.select().from(jobs).where(eq(jobs.id, jobId)))[0].technicianId
    expect(await technicianOf(booked.id)).toBeNull()
    expect(await technicianOf(noAccess.id)).toBeNull()
    expect(await technicianOf(enRoute.id)).toBe(shop.mike.id) // already on the way: left alone
    expect(await technicianOf(past.id)).toBe(shop.mike.id) // history keeps the name
    expect(await technicianOf(anas.id)).toBe(shop.ana.id)

    const [mike] = await db.select().from(users).where(eq(users.id, shop.mike.id))
    expect(mike.disabledAt).toBeInstanceOf(Date)
    expect(await db.select().from(sessions).where(eq(sessions.userId, shop.mike.id))).toEqual([])

    const [audit] = await db.select().from(auditEvents)
    expect(audit).toMatchObject({
      action: 'user.deactivated',
      entityId: shop.mike.id,
      data: { unassignedJobIds: expect.arrayContaining([booked.id, noAccess.id]) },
    })
    expect(emitToTenant).toHaveBeenCalledWith(shop.tenant.id, 'team.updated', {
      tenantId: shop.tenant.id,
    })
    expect(emitToTenant).toHaveBeenCalledWith(shop.tenant.id, 'job.assigned', {
      jobId: expect.any(String),
      dates: [TUESDAY, WEDNESDAY],
    })

    // A deactivated technician can't be put back on a job.
    const assign = await request(app)
      .put(`/api/jobs/${booked.id}/slot`)
      .set('Cookie', shop.cookie)
      .send({ date: TUESDAY, windowId: shop.tueMorning.id, technicianId: shop.mike.id })
      .expect(422)
    expect(assign.body.error.message).toBe('That technician isn’t available. Pick another one.')
  })

  it('does nothing more the second time', async () => {
    const shop = await createShop('desert')
    const url = `/api/technicians/${shop.mike.id}/deactivate`
    await request(app).post(url).set('Cookie', shop.cookie).expect(200)
    const again = await request(app).post(url).set('Cookie', shop.cookie).expect(200)
    expect(again.body.unassignedJobs).toBe(0)
  })

  it("404s for another contractor's technician", async () => {
    const shop = await createShop('desert')
    const other = await createShop('other')
    await request(app)
      .post(`/api/technicians/${other.mike.id}/deactivate`)
      .set('Cookie', shop.cookie)
      .expect(404)
  })
})

describe('POST /api/technicians/:technicianId/reactivate', () => {
  it('puts a technician back on the team', async () => {
    const shop = await createShop('desert')
    await request(app)
      .post(`/api/technicians/${shop.mike.id}/deactivate`)
      .set('Cookie', shop.cookie)
      .expect(200)
    vi.mocked(emitToTenant).mockClear()

    const res = await request(app)
      .post(`/api/technicians/${shop.mike.id}/reactivate`)
      .set('Cookie', shop.cookie)
      .expect(200)

    expect(res.body.technician).toMatchObject({ id: shop.mike.id, active: true })
    const [mike] = await db.select().from(users).where(eq(users.id, shop.mike.id))
    expect(mike.disabledAt).toBeNull()
    expect(emitToTenant).toHaveBeenCalledWith(shop.tenant.id, 'team.updated', {
      tenantId: shop.tenant.id,
    })
  })
})
