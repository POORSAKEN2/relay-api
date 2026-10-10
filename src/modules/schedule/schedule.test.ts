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
} from '../../../test/helpers.ts'
import { createApp } from '../../app.ts'
import { db } from '../../db/client.ts'
import { arrivalWindows, auditEvents, businessHours } from '../../db/schema.ts'
import { emitToTenant } from '../../realtime/index.ts'

vi.mock('../../realtime/index.ts', () => ({ emitToTenant: vi.fn() }))

const app = createApp()

beforeEach(async () => {
  await resetDb()
  vi.mocked(emitToTenant).mockClear()
})

const WEEKDAYS = [1, 2, 3, 4, 5]

// Mon–Fri 7–6, windows 8–12 and 1–5 (cap 3) on Mon–Fri.
function weekSchedule(overrides: Record<string, unknown> = {}) {
  return {
    hours: { days: WEEKDAYS, opensAt: '07:00', closesAt: '18:00' },
    windows: [
      { startsAt: '08:00', endsAt: '12:00', jobCap: 3 },
      { startsAt: '13:00', endsAt: '17:00', jobCap: 3 },
    ],
    windowDays: WEEKDAYS,
    ...overrides,
  }
}

function getSchedule(shop: Shop) {
  return request(app).get('/api/schedule').set('Cookie', shop.cookie)
}

function saveSchedule(shop: Shop, body: object) {
  return request(app).put('/api/schedule').set('Cookie', shop.cookie).send(body)
}

function windowsOf(shop: Shop) {
  return db.select().from(arrivalWindows).where(eq(arrivalWindows.tenantId, shop.tenant.id))
}

describe('GET /api/schedule', () => {
  // The test shop has 8–12 and 12–4 (cap 2) on Tuesdays and Wednesdays, and no hours.
  it('returns the saved windows, their days, and no hours', async () => {
    const shop = await createShop('desert')

    const res = await getSchedule(shop).expect(200)
    expect(res.body).toEqual({
      hours: null,
      windows: [
        { startsAt: '08:00', endsAt: '12:00', jobCap: 2 },
        { startsAt: '12:00', endsAt: '16:00', jobCap: 2 },
      ],
      windowDays: [2, 3],
    })
  })

  it('shows the first day’s windows when saved days differ', async () => {
    const shop = await createShop('desert')
    await db
      .update(arrivalWindows)
      .set({ jobCap: 5 })
      .where(eq(arrivalWindows.id, shop.wedMorning.id))

    const res = await getSchedule(shop).expect(200)
    expect(res.body.windows[0]).toEqual({ startsAt: '08:00', endsAt: '12:00', jobCap: 2 })
  })
})

describe('PUT /api/schedule', () => {
  it('saves hours and windows on the ticked days and records who changed them', async () => {
    const shop = await createShop('desert')

    const res = await saveSchedule(shop, weekSchedule()).expect(200)
    expect(res.body).toEqual(weekSchedule())

    const hours = await db
      .select()
      .from(businessHours)
      .where(eq(businessHours.tenantId, shop.tenant.id))
    expect(hours.map((row) => row.weekday).sort()).toEqual(WEEKDAYS)
    expect(hours[0]).toMatchObject({ opensAt: '07:00:00', closesAt: '18:00:00' })
    expect(await windowsOf(shop)).toHaveLength(10)

    const audit = await db.select().from(auditEvents)
    expect(audit).toEqual([
      expect.objectContaining({
        actorUserId: shop.office.id,
        action: 'settings.schedule_updated',
        data: { hoursDays: WEEKDAYS, windowDays: WEEKDAYS, windows: 2 },
      }),
    ])
    expect(emitToTenant).toHaveBeenCalledWith(shop.tenant.id, 'schedule.updated', {
      tenantId: shop.tenant.id,
    })
  })

  it('keeps a window’s id when its start time stays, so a waitlist offer on it still works', async () => {
    const shop = await createShop('desert')

    await saveSchedule(shop, weekSchedule()).expect(200)

    const windows = await windowsOf(shop)
    const tueMorning = windows.find((w) => w.id === shop.tueMorning.id)
    expect(tueMorning).toMatchObject({ weekday: 2, startsAt: '08:00:00', jobCap: 3 })
    // 12–4 has no match in the new schedule: removed.
    expect(windows.find((w) => w.id === shop.tueAfternoon.id)).toBeUndefined()
  })

  it('changes nothing when saved again unchanged', async () => {
    const shop = await createShop('desert')
    await saveSchedule(shop, weekSchedule()).expect(200)
    const before = (await windowsOf(shop)).map((w) => w.id).sort()

    await saveSchedule(shop, weekSchedule()).expect(200)

    expect((await windowsOf(shop)).map((w) => w.id).sort()).toEqual(before)
  })

  it('removes windows from unticked days and clears hours when closed every day', async () => {
    const shop = await createShop('desert')
    await saveSchedule(shop, weekSchedule()).expect(200)

    const res = await saveSchedule(shop, weekSchedule({ hours: null, windowDays: [3] })).expect(200)

    expect(res.body.hours).toBeNull()
    expect(res.body.windowDays).toEqual([3])
    expect(await db.select().from(businessHours)).toEqual([])
    expect((await windowsOf(shop)).map((w) => w.weekday)).toEqual([3, 3])
  })

  it('sorts windows by start and saves a day ticked twice once', async () => {
    const shop = await createShop('desert')
    const body = weekSchedule({
      windows: [
        { startsAt: '13:00', endsAt: '17:00', jobCap: 3 },
        { startsAt: '08:00', endsAt: '12:00', jobCap: 3 },
      ],
      windowDays: [3, 2, 2],
    })

    const res = await saveSchedule(shop, body).expect(200)

    expect(res.body.windows.map((w: { startsAt: string }) => w.startsAt)).toEqual([
      '08:00',
      '13:00',
    ])
    expect(res.body.windowDays).toEqual([2, 3])
    expect(await windowsOf(shop)).toHaveLength(4)
  })

  it('refuses overlapping windows, including two with the same start', async () => {
    const shop = await createShop('desert')

    const overlap = await saveSchedule(
      shop,
      weekSchedule({
        windows: [
          { startsAt: '08:00', endsAt: '12:00', jobCap: 3 },
          { startsAt: '11:00', endsAt: '14:00', jobCap: 3 },
        ],
      }),
    ).expect(400)
    expect(overlap.body.error.details).toEqual({
      'windows.1.startsAt': ['Windows can’t overlap: 8 AM–12 PM and 11 AM–2 PM'],
    })

    const sameStart = await saveSchedule(
      shop,
      weekSchedule({
        windows: [
          { startsAt: '08:00', endsAt: '12:00', jobCap: 3 },
          { startsAt: '08:00', endsAt: '10:00', jobCap: 3 },
        ],
      }),
    ).expect(400)
    expect(Object.keys(sameStart.body.error.details)).toEqual(['windows.1.startsAt'])
    // Nothing was saved.
    expect(await windowsOf(shop)).toHaveLength(4)
  })

  it('refuses bad times, caps and days', async () => {
    const shop = await createShop('desert')
    const window = { startsAt: '08:00', endsAt: '12:00', jobCap: 3 }

    const cases: [Record<string, unknown>, string, string][] = [
      [{ windows: [{ ...window, endsAt: '08:00' }] }, 'windows.0.endsAt', 'End after the start'],
      [
        { windows: [{ ...window, jobCap: 0 }] },
        'windows.0.jobCap',
        'Enter a cap from 1 to 20 jobs',
      ],
      [
        { windows: [{ ...window, jobCap: 21 }] },
        'windows.0.jobCap',
        'Enter a cap from 1 to 20 jobs',
      ],
      [
        { windows: [{ ...window, jobCap: 2.5 }] },
        'windows.0.jobCap',
        'Enter a cap from 1 to 20 jobs',
      ],
      [
        { windows: [{ ...window, startsAt: '08:15' }] },
        'windows.0.startsAt',
        'Pick a time on the hour or half hour',
      ],
      [{ windows: [] }, 'windows', 'Add at least one arrival window'],
      [{ windowDays: [] }, 'windowDays', 'Tick at least one day for the windows'],
      [{ windowDays: [7] }, 'windowDays.0', 'Pick a day of the week'],
      [
        { hours: { days: WEEKDAYS, opensAt: '18:00', closesAt: '07:00' } },
        'hours.closesAt',
        'Close after you open',
      ],
      [
        { hours: { days: [], opensAt: '07:00', closesAt: '18:00' } },
        'hours.days',
        'Tick at least one day',
      ],
    ]
    for (const [overrides, field, message] of cases) {
      const res = await saveSchedule(shop, weekSchedule(overrides)).expect(400)
      expect(res.body.error.details[field], field).toEqual([message])
    }

    const nine = Array.from({ length: 9 }, (_, i) => ({
      startsAt: `${String(8 + i).padStart(2, '0')}:00`,
      endsAt: `${String(8 + i).padStart(2, '0')}:30`,
      jobCap: 1,
    }))
    const tooMany = await saveSchedule(shop, weekSchedule({ windows: nine })).expect(400)
    expect(tooMany.body.error.details.windows).toEqual(['Keep it to 8 windows or fewer'])
  })

  it('leaves other contractors’ schedules alone', async () => {
    const shop = await createShop('desert')
    const other = await createShop('other')

    await saveSchedule(shop, weekSchedule({ windowDays: [1] })).expect(200)

    expect((await getSchedule(other)).body.windowDays).toEqual([2, 3])
  })

  it('gives the booking page the new windows', async () => {
    const shop = await createShop('desert')
    await saveSchedule(
      shop,
      weekSchedule({ windows: [{ startsAt: '09:00', endsAt: '13:00', jobCap: 2 }] }),
    ).expect(200)

    const res = await request(app)
      .get('/api/online-booking/windows')
      .set('X-Tenant-Host', 'desert.localhost')
      .expect(200)
    const labels = res.body.days.flatMap((day: { windows: { label: string }[] }) =>
      day.windows.map((window) => window.label),
    )
    expect(new Set(labels)).toEqual(new Set(['9 AM–1 PM']))
  })
})

it('is for owner and office staff only', async () => {
  const shop = await createShop('desert')
  const technician = await createUser('technician', shop.tenant.id)
  const cookie = await signIn(technician.email)

  await request(app).get('/api/schedule').expect(401)
  await request(app).get('/api/schedule').set('Cookie', cookie).expect(403)
  await request(app).put('/api/schedule').set('Cookie', cookie).send(weekSchedule()).expect(403)
})

describe('POST /api/schedule/check', () => {
  function check(shop: Shop, body: object) {
    return request(app).post('/api/schedule/check').set('Cookie', shop.cookie).send(body)
  }

  // The test shop as it is: 8–12 and 12–4, cap 2, Tuesdays and Wednesdays.
  function shopSchedule(overrides: Record<string, unknown> = {}) {
    return {
      hours: null,
      windows: [
        { startsAt: '08:00', endsAt: '12:00', jobCap: 2 },
        { startsAt: '12:00', endsAt: '16:00', jobCap: 2 },
      ],
      windowDays: [2, 3],
      ...overrides,
    }
  }

  it('finds no jobs when nothing changes', async () => {
    const shop = await createShop('desert')
    await createJob(shop, { at: `${TUESDAY} 08:00` })
    await createJob(shop, { at: `${TUESDAY} 12:00` })

    const res = await check(shop, shopSchedule()).expect(200)
    expect(res.body).toEqual({ affectedJobs: 0 })
  })

  it('counts jobs in a removed window, a window whose end moved, and on an unticked day', async () => {
    const shop = await createShop('desert')
    await createJob(shop, { at: `${TUESDAY} 08:00` })
    await createJob(shop, { at: `${TUESDAY} 12:00` })

    // 12–4 removed.
    const removed = shopSchedule({ windows: [{ startsAt: '08:00', endsAt: '12:00', jobCap: 2 }] })
    expect((await check(shop, removed).expect(200)).body.affectedJobs).toBe(1)
    // 8–12 becomes 8–11.
    const shorter = shopSchedule({
      windows: [
        { startsAt: '08:00', endsAt: '11:00', jobCap: 2 },
        { startsAt: '12:00', endsAt: '16:00', jobCap: 2 },
      ],
    })
    expect((await check(shop, shorter).expect(200)).body.affectedJobs).toBe(1)
    // Tuesdays unticked.
    const noTuesday = shopSchedule({ windowDays: [3] })
    expect((await check(shop, noTuesday).expect(200)).body.affectedJobs).toBe(2)
  })

  it('ignores past, cancelled and done jobs, jobs already under Other times, and a lowered cap', async () => {
    const shop = await createShop('desert')
    await createJob(shop, { at: '2020-01-07 08:00' }) // a Tuesday in the past
    await createJob(shop, { at: `${TUESDAY} 08:00`, status: 'cancelled' })
    await createJob(shop, { at: `${TUESDAY} 08:00`, status: 'done', technicianId: shop.ana.id })
    await createJob(shop, { at: `${TUESDAY} 09:00`, hours: 2 }) // matches no window today
    await createJob(shop, { at: `${TUESDAY} 12:00` })
    await createJob(shop, { at: `${TUESDAY} 12:00` })

    // 8–12 removed, where only the jobs to ignore sit. 12–4 keeps two booked, cap lowered to 1.
    const lowerCap = shopSchedule({
      windows: [{ startsAt: '12:00', endsAt: '16:00', jobCap: 1 }],
    })
    const res = await check(shop, lowerCap).expect(200)
    expect(res.body).toEqual({ affectedJobs: 0 })
  })

  it('saves nothing and checks the input like a save', async () => {
    const shop = await createShop('desert')

    await check(shop, shopSchedule({ windowDays: [1] })).expect(200)
    expect((await getSchedule(shop)).body.windowDays).toEqual([2, 3])

    const res = await check(shop, shopSchedule({ windows: [] })).expect(400)
    expect(res.body.error.details.windows).toEqual(['Add at least one arrival window'])
  })

  it('is for owner and office staff only', async () => {
    const shop = await createShop('desert')
    const technician = await createUser('technician', shop.tenant.id)

    await request(app)
      .post('/api/schedule/check')
      .set('Cookie', await signIn(technician.email))
      .send(shopSchedule())
      .expect(403)
  })
})
