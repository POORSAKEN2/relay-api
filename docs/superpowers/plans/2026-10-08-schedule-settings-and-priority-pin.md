# Schedule settings and priority pin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Owner and office edit business hours, arrival windows and the jobs-per-window cap on a new Schedule page, and the dispatch board shows the day's priority jobs in a section at the top.

**Architecture:** relay-api gets a `schedule` module with three routes (`GET /api/schedule`, `POST /api/schedule/check`, `PUT /api/schedule`) that read and replace the whole schedule in one transaction, keeping window ids whose start time is unchanged. relay-web gets a Schedule page (one form, browser-side validation mirroring the API, a warning dialog when upcoming jobs are touched) and a Priority section on the dashboard built from the board data it already loads.

**Tech Stack:** relay-api: Node 22, Express 5, Drizzle ORM (Postgres), zod 4, vitest + supertest. relay-web: React 19, React Router, TanStack Query, zod, Tailwind, Base UI, vitest.

**Spec:** `relay-api/docs/superpowers/specs/2026-10-08-schedule-settings-and-priority-pin-design.md`

**Two repos.** Tasks 1–2 are in `D:\Sen\personal\HVAC\relay-api` on branch `feat/schedule-settings` (already created, holds the spec). Tasks 3–5 are in `D:\Sen\personal\HVAC\relay-web`: before Task 3, run `git checkout main && git pull && git checkout -b feat/schedule-settings` there. `relay-web` has an untracked `src/features/auth/landing.test.ts` that isn't part of this work: never `git add` it (add files by name).

**Commands.** In each repo: `npm test` (vitest run), `npm run typecheck`, `npm run lint`. One test file: `npx vitest run <path>`. relay-api tests need the local test database the existing suite already uses.

## Global Constraints

- Owner and office only: `requireRole('owner', 'office')` on every route; the page sits in the existing owner/office staff layout.
- Times are `'HH:MM'` in the contractor's local time, minutes `00` or `30`, from `00:00` to `23:30`. `closesAt > opensAt`, `endsAt > startsAt`. Nothing runs past midnight.
- `windows`: 1–8 items, `jobCap` an integer 1–20, no two windows overlap (touching is fine: 8–12 and 12–4).
- `windowDays`: 1–7 distinct values in 0–6 (0 = Sunday). `hours`: `null` (closed every day) or `days` with 1–7 distinct values.
- Windows outside business hours are allowed. Nothing reads business hours yet.
- Booked jobs never move. Saving only changes what new bookings can pick.
- Copy: plain words, sentence case, the messages exactly as written in this plan.
- Audit action: `settings.schedule_updated`. Realtime event: `schedule.updated` with `{ tenantId }`.

## Review Focus

- Two windows with the same start time → a field error ("Windows can't overlap…"), never a 500 from the `(tenant_id, weekday, starts_at)` unique key. Pinned in Task 1.
- A day ticked twice (`[2, 2, 3]`) → saved once, never a primary-key 500. Pinned in Task 1.
- A cap lowered below what's already booked → saves with no warning, the window just shows as full. Pinned in Task 2.
- Last window ending at 11:30 PM → "Add window" is disabled, never a window past midnight. Pinned in Task 3.
- A cap typed as `4.5`, `0` or left empty → a field error in the browser, never `NaN` sent to the API. Pinned in Task 3.

---

### Task 1: Schedule API — read and save

**Files:**
- Create: `relay-api/src/modules/schedule/schedule.schemas.ts`
- Create: `relay-api/src/modules/schedule/schedule.queries.ts`
- Create: `relay-api/src/modules/schedule/schedule.service.ts`
- Create: `relay-api/src/modules/schedule/schedule.routes.ts`
- Create: `relay-api/src/modules/schedule/schedule.test.ts`
- Modify: `relay-api/src/app.ts` (import + mount `scheduleRoutes` after `receptionistRoutes`)
- Modify: `relay-api/src/realtime/events.ts` (add `schedule.updated`)

**Interfaces:**
- Consumes: `requireRole` (`src/middleware/auth.ts`), `tenantOf` (`src/modules/booking/booking.service.ts`), `audit.insertUserAction`, `emitToTenant`, `formatWindow` (`src/lib/labels.ts`), test helpers `createShop`, `createUser`, `createJob`, `signIn`, `resetDb`, `TUESDAY`.
- Produces:
  - `ScheduleInput` (zod) and `type Schedule = { hours: { days: number[]; opensAt: string; closesAt: string } | null; windows: { startsAt: string; endsAt: string; jobCap: number }[]; windowDays: number[] }` from `schedule.schemas.ts`.
  - `queries.listWindows(tenantId, tx?)` → `{ id, weekday, startsAt, endsAt, jobCap }[]` (times as `'HH:MM:SS'`), ordered by weekday then start.
  - `service.getSchedule(tenantId): Promise<Schedule>`, `service.saveSchedule(user, schedule): Promise<Schedule>`, `hhmm(time: string): string`.
  - Routes `GET /api/schedule`, `PUT /api/schedule`.

- [ ] **Step 1: Write the failing tests**

Create `relay-api/src/modules/schedule/schedule.test.ts`:

```ts
import { eq } from 'drizzle-orm'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createShop, createUser, resetDb, type Shop, signIn } from '../../../test/helpers.ts'
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

function saveSchedule(shop: Shop, body: unknown) {
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
      [{ windows: [{ ...window, jobCap: 0 }] }, 'windows.0.jobCap', 'Enter a cap from 1 to 20 jobs'],
      [{ windows: [{ ...window, jobCap: 21 }] }, 'windows.0.jobCap', 'Enter a cap from 1 to 20 jobs'],
      [{ windows: [{ ...window, jobCap: 2.5 }] }, 'windows.0.jobCap', 'Enter a cap from 1 to 20 jobs'],
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/modules/schedule/schedule.test.ts`
Expected: FAIL — the routes don't exist (`404`), and `schedule.updated` isn't a known event.

- [ ] **Step 3: Add the realtime event**

In `relay-api/src/realtime/events.ts`, add to `RealtimeEvents` after `'services.updated'`:

```ts
  // Business hours or arrival windows changed: the board and the Schedule page refresh.
  'schedule.updated': { tenantId: string }
```

- [ ] **Step 4: Write the input schema**

Create `relay-api/src/modules/schedule/schedule.schemas.ts`:

```ts
import { z } from 'zod'
import { formatWindow } from '../../lib/labels.ts'

const MAX_WINDOWS = 8
const CAP_MESSAGE = 'Enter a cap from 1 to 20 jobs'

// The contractor's local time, on the hour or half hour: '08:00', '13:30'.
const Time = z
  .string('Pick a time on the hour or half hour')
  .regex(/^([01]\d|2[0-3]):(00|30)$/, 'Pick a time on the hour or half hour')

// Days of the week, 0 = Sunday … 6 = Saturday. A day listed twice counts once.
const Days = (emptyMessage: string) =>
  z
    .array(z.number().int().min(0, 'Pick a day of the week').max(6, 'Pick a day of the week'))
    .min(1, emptyMessage)
    .transform((days) => [...new Set(days)].sort((a, b) => a - b))

const Hours = z
  .object({ days: Days('Tick at least one day'), opensAt: Time, closesAt: Time })
  .refine((hours) => hours.closesAt > hours.opensAt, {
    message: 'Close after you open',
    path: ['closesAt'],
  })

const Window = z
  .object({
    startsAt: Time,
    endsAt: Time,
    jobCap: z.number(CAP_MESSAGE).int(CAP_MESSAGE).min(1, CAP_MESSAGE).max(20, CAP_MESSAGE),
  })
  .refine((window) => window.endsAt > window.startsAt, {
    message: 'End after the start',
    path: ['endsAt'],
  })

// The whole schedule: one set of hours and one set of windows, each with the days it applies
// to. `hours: null` means closed every day. Windows come back sorted by start.
export const ScheduleInput = z
  .object({
    hours: Hours.nullable(),
    windows: z
      .array(Window)
      .min(1, 'Add at least one arrival window')
      .max(MAX_WINDOWS, 'Keep it to 8 windows or fewer'),
    windowDays: Days('Tick at least one day for the windows'),
  })
  .superRefine((schedule, ctx) => {
    const sorted = schedule.windows
      .map((window, index) => ({ ...window, index }))
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.index - b.index)
    for (let i = 1; i < sorted.length; i++) {
      const previous = sorted[i - 1]
      const current = sorted[i]
      if (current.startsAt < previous.endsAt) {
        ctx.addIssue({
          code: 'custom',
          path: ['windows', current.index, 'startsAt'],
          message: `Windows can’t overlap: ${formatWindow(previous.startsAt, previous.endsAt)} and ${formatWindow(current.startsAt, current.endsAt)}`,
        })
      }
    }
  })
  .transform((schedule) => ({
    ...schedule,
    windows: [...schedule.windows].sort((a, b) => a.startsAt.localeCompare(b.startsAt)),
  }))

export type Schedule = z.infer<typeof ScheduleInput>
```

- [ ] **Step 5: Write the queries**

Create `relay-api/src/modules/schedule/schedule.queries.ts`:

```ts
import { and, asc, eq, inArray } from 'drizzle-orm'
import { type Db, db, type Tx } from '../../db/client.ts'
import { arrivalWindows, businessHours } from '../../db/schema.ts'

// Tenant-scoped: every query takes tenantId first. Times are the contractor's wall clock, as
// Postgres returns them ('08:00:00').

export function listHours(tenantId: string, tx: Db = db) {
  return tx
    .select({
      weekday: businessHours.weekday,
      opensAt: businessHours.opensAt,
      closesAt: businessHours.closesAt,
    })
    .from(businessHours)
    .where(eq(businessHours.tenantId, tenantId))
    .orderBy(asc(businessHours.weekday))
}

export function listWindows(tenantId: string, tx: Db = db) {
  return tx
    .select({
      id: arrivalWindows.id,
      weekday: arrivalWindows.weekday,
      startsAt: arrivalWindows.startsAt,
      endsAt: arrivalWindows.endsAt,
      jobCap: arrivalWindows.jobCap,
    })
    .from(arrivalWindows)
    .where(eq(arrivalWindows.tenantId, tenantId))
    .orderBy(asc(arrivalWindows.weekday), asc(arrivalWindows.startsAt))
}

// Swaps the contractor's hours for `rows` (none: closed every day).
export async function replaceHours(
  tenantId: string,
  rows: { weekday: number; opensAt: string; closesAt: string }[],
  tx: Tx,
) {
  await tx.delete(businessHours).where(eq(businessHours.tenantId, tenantId))
  if (rows.length > 0) {
    await tx.insert(businessHours).values(rows.map((row) => ({ tenantId, ...row })))
  }
}

export async function deleteWindows(tenantId: string, ids: string[], tx: Tx) {
  if (ids.length === 0) return
  await tx
    .delete(arrivalWindows)
    .where(and(eq(arrivalWindows.tenantId, tenantId), inArray(arrivalWindows.id, ids)))
}

// Never changes starts_at, so it can't clash with the (tenant, weekday, starts_at) key.
export async function updateWindow(
  tenantId: string,
  id: string,
  values: { endsAt: string; jobCap: number },
  tx: Tx,
) {
  await tx
    .update(arrivalWindows)
    .set(values)
    .where(and(eq(arrivalWindows.tenantId, tenantId), eq(arrivalWindows.id, id)))
}

export async function insertWindows(
  tenantId: string,
  rows: { weekday: number; startsAt: string; endsAt: string; jobCap: number }[],
  tx: Tx,
) {
  if (rows.length === 0) return
  await tx.insert(arrivalWindows).values(rows.map((row) => ({ tenantId, ...row })))
}
```

- [ ] **Step 6: Write the service**

Create `relay-api/src/modules/schedule/schedule.service.ts`:

```ts
import { db, type Tx } from '../../db/client.ts'
import { emitToTenant } from '../../realtime/index.ts'
import type { SessionUser } from '../accounts/accounts.service.ts'
import * as audit from '../audit/audit.queries.ts'
import { tenantOf } from '../booking/booking.service.ts'
import * as queries from './schedule.queries.ts'
import type { Schedule } from './schedule.schemas.ts'

// Owner and office set when they're open and which arrival windows customers can book, with
// how many jobs each window takes. The screen edits one shared set for all ticked days.

// '08:00:00' → '08:00'
export function hhmm(time: string): string {
  return time.slice(0, 5)
}

// Days whose saved rows differ (only possible from old data) show the lowest day's values.
export async function getSchedule(tenantId: string): Promise<Schedule> {
  const [hours, windows] = await Promise.all([
    queries.listHours(tenantId),
    queries.listWindows(tenantId),
  ])
  const windowDays = [...new Set(windows.map((window) => window.weekday))]
  return {
    hours:
      hours.length === 0
        ? null
        : {
            days: hours.map((row) => row.weekday),
            opensAt: hhmm(hours[0].opensAt),
            closesAt: hhmm(hours[0].closesAt),
          },
    windows: windows
      .filter((window) => window.weekday === windowDays[0])
      .map((window) => ({
        startsAt: hhmm(window.startsAt),
        endsAt: hhmm(window.endsAt),
        jobCap: window.jobCap,
      })),
    windowDays,
  }
}

// Replaces the whole schedule. Jobs already booked keep their times.
export async function saveSchedule(user: SessionUser, schedule: Schedule) {
  const tenantId = tenantOf(user)
  const { hours } = schedule
  await db.transaction(async (tx) => {
    await queries.replaceHours(
      tenantId,
      hours
        ? hours.days.map((weekday) => ({ weekday, opensAt: hours.opensAt, closesAt: hours.closesAt }))
        : [],
      tx,
    )
    await syncWindows(tenantId, schedule, tx)
    await audit.insertUserAction(
      tenantId,
      {
        actorUserId: user.id,
        action: 'settings.schedule_updated',
        entityType: 'tenant',
        entityId: tenantId,
        data: {
          hoursDays: hours?.days ?? [],
          windowDays: schedule.windowDays,
          windows: schedule.windows.length,
        },
      },
      tx,
    )
  })
  emitToTenant(tenantId, 'schedule.updated', { tenantId })
  return getSchedule(tenantId)
}

// A saved window whose day and start time stay is updated in place, keeping its id: an open
// waitlist offer holds a window by id. The rest are deleted, then the new ones inserted, so
// the (tenant, weekday, starts_at) key never clashes mid-save.
async function syncWindows(tenantId: string, schedule: Schedule, tx: Tx) {
  const saved = await queries.listWindows(tenantId, tx)
  const kept = new Set<string>()
  const updates: { id: string; endsAt: string; jobCap: number }[] = []
  const inserts: { weekday: number; startsAt: string; endsAt: string; jobCap: number }[] = []
  for (const weekday of schedule.windowDays) {
    for (const window of schedule.windows) {
      const match = saved.find(
        (row) => row.weekday === weekday && hhmm(row.startsAt) === window.startsAt,
      )
      if (match) {
        kept.add(match.id)
        updates.push({ id: match.id, endsAt: window.endsAt, jobCap: window.jobCap })
      } else {
        inserts.push({ weekday, ...window })
      }
    }
  }
  await queries.deleteWindows(
    tenantId,
    saved.filter((row) => !kept.has(row.id)).map((row) => row.id),
    tx,
  )
  for (const { id, ...values } of updates) await queries.updateWindow(tenantId, id, values, tx)
  await queries.insertWindows(tenantId, inserts, tx)
}
```

- [ ] **Step 7: Write the routes and mount them**

Create `relay-api/src/modules/schedule/schedule.routes.ts`:

```ts
import { Router } from 'express'
import { requireRole } from '../../middleware/auth.ts'
import { tenantOf } from '../booking/booking.service.ts'
import { ScheduleInput } from './schedule.schemas.ts'
import * as service from './schedule.service.ts'

export const scheduleRoutes = Router()

const staff = requireRole('owner', 'office')

scheduleRoutes.get('/schedule', staff, async (req, res) => {
  res.json(await service.getSchedule(tenantOf(req.user!)))
})

scheduleRoutes.put('/schedule', staff, async (req, res) => {
  const schedule = ScheduleInput.parse(req.body)
  res.json(await service.saveSchedule(req.user!, schedule))
})
```

In `relay-api/src/app.ts`, add the import with the other module routes (alphabetical, after `receptionistRoutes`):

```ts
import { scheduleRoutes } from './modules/schedule/schedule.routes.ts'
```

and add `scheduleRoutes,` to the `app.use('/api', …)` list right after `receptionistRoutes,`.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run src/modules/schedule/schedule.test.ts`
Expected: PASS (12 tests). If the "refuses bad times" case for `jobCap: 2.5` reports an extra message, check the zod 4 `.int()` message is `CAP_MESSAGE`.

- [ ] **Step 9: Run the whole suite, typecheck and lint**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all pass.

- [ ] **Step 10: Commit**

```bash
git add src/modules/schedule src/app.ts src/realtime/events.ts
git commit -m "feat: read and save business hours and arrival windows"
```

---

### Task 2: Schedule API — check which upcoming jobs a change touches

**Files:**
- Modify: `relay-api/src/modules/schedule/schedule.queries.ts` (add `listUpcomingJobs`)
- Modify: `relay-api/src/modules/schedule/schedule.service.ts` (add `countAffected`, `placesOf`, `checkSchedule`)
- Modify: `relay-api/src/modules/schedule/schedule.routes.ts` (add `POST /schedule/check`)
- Test: `relay-api/src/modules/schedule/schedule.test.ts`

**Interfaces:**
- Consumes: `Schedule`, `ScheduleInput`, `hhmm`, `queries.listWindows` from Task 1; `INACTIVE_STATUSES` (`src/modules/booking/booking.queries.ts`); `local` (`src/modules/dispatch/dispatch.queries.ts`).
- Produces: `POST /api/schedule/check` → `{ affectedJobs: number }`; `service.checkSchedule(tenantId, schedule)`.

- [ ] **Step 1: Write the failing tests**

In `schedule.test.ts`, change the helpers import to:

```ts
import {
  createJob,
  createShop,
  createUser,
  resetDb,
  type Shop,
  signIn,
  TUESDAY,
} from '../../../test/helpers.ts'
```

and append:

```ts
describe('POST /api/schedule/check', () => {
  function check(shop: Shop, body: unknown) {
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
    await createJob(shop, { at: `${TUESDAY} 08:00`, status: 'done' })
    await createJob(shop, { at: `${TUESDAY} 09:00`, hours: 2 }) // matches no window today
    await createJob(shop, { at: `${TUESDAY} 12:00` })
    await createJob(shop, { at: `${TUESDAY} 12:00` })

    const lowerCap = shopSchedule({
      windows: [
        { startsAt: '08:00', endsAt: '12:00', jobCap: 2 },
        { startsAt: '12:00', endsAt: '16:00', jobCap: 1 }, // two booked, cap lowered to 1
      ],
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/modules/schedule/schedule.test.ts`
Expected: the five new tests FAIL with `404`.

- [ ] **Step 3: Add the upcoming-jobs query**

In `schedule.queries.ts`, change the imports to:

```ts
import { and, asc, eq, gte, inArray, notInArray, sql } from 'drizzle-orm'
import { type Db, db, type Tx } from '../../db/client.ts'
import { arrivalWindows, businessHours, jobs, tenants } from '../../db/schema.ts'
import { INACTIVE_STATUSES } from '../booking/booking.queries.ts'
import { local } from '../dispatch/dispatch.queries.ts'
```

and append:

```ts
// Jobs from now on still holding a place, as the contractor's wall clock: weekday and
// 'HH:MM' start and end.
export function listUpcomingJobs(tenantId: string, tx: Db = db) {
  return tx
    .select({
      weekday: sql<number>`extract(dow from ${jobs.windowStartsAt} at time zone ${tenants.timezone})`.mapWith(
        Number,
      ),
      startsAt: local(jobs.windowStartsAt, 'HH24:MI'),
      endsAt: local(jobs.windowEndsAt, 'HH24:MI'),
    })
    .from(jobs)
    .innerJoin(tenants, eq(tenants.id, jobs.tenantId))
    .where(
      and(
        eq(jobs.tenantId, tenantId),
        notInArray(jobs.status, [...INACTIVE_STATUSES, 'done' as const]),
        gte(jobs.windowStartsAt, sql`now()`),
      ),
    )
}
```

- [ ] **Step 4: Add the check to the service**

In `schedule.service.ts`, append:

```ts
// A place a job can hold: a weekday and a window's local start and end ('HH:MM').
type Place = { weekday: number; startsAt: string; endsAt: string }

function fits(job: Place, places: Place[]) {
  return places.some(
    (place) =>
      place.weekday === job.weekday &&
      place.startsAt === job.startsAt &&
      place.endsAt === job.endsAt,
  )
}

// Every weekday × window of a schedule.
export function placesOf(schedule: Pick<Schedule, 'windows' | 'windowDays'>): Place[] {
  return schedule.windowDays.flatMap((weekday) =>
    schedule.windows.map(({ startsAt, endsAt }) => ({ weekday, startsAt, endsAt })),
  )
}

// Jobs that sit in a window today and would sit in none after the change. A job already
// outside every window ("Other times") isn't counted, and neither is a lowered cap: the window
// just shows as full.
export function countAffected(jobs: Place[], before: Place[], after: Place[]): number {
  return jobs.filter((job) => fits(job, before) && !fits(job, after)).length
}

// How many upcoming jobs a change would touch, so the page can warn before saving.
export async function checkSchedule(tenantId: string, schedule: Schedule) {
  const [jobs, saved] = await Promise.all([
    queries.listUpcomingJobs(tenantId),
    queries.listWindows(tenantId),
  ])
  const before = saved.map((window) => ({
    weekday: window.weekday,
    startsAt: hhmm(window.startsAt),
    endsAt: hhmm(window.endsAt),
  }))
  return { affectedJobs: countAffected(jobs, before, placesOf(schedule)) }
}
```

- [ ] **Step 5: Add the route**

In `schedule.routes.ts`, between the GET and PUT routes:

```ts
// Saves nothing: how many upcoming jobs the change would touch.
scheduleRoutes.post('/schedule/check', staff, async (req, res) => {
  const schedule = ScheduleInput.parse(req.body)
  res.json(await service.checkSchedule(tenantOf(req.user!), schedule))
})
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/modules/schedule/schedule.test.ts`
Expected: PASS (17 tests).

- [ ] **Step 7: Run the whole suite, typecheck and lint**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/modules/schedule
git commit -m "feat: count the upcoming jobs a schedule change touches"
```

---

### Task 3: Schedule form rules (relay-web)

First, in `D:\Sen\personal\HVAC\relay-web`: `git checkout main && git pull && git checkout -b feat/schedule-settings`.

**Files:**
- Create: `relay-web/src/features/schedule/rules.ts`
- Test: `relay-web/src/features/schedule/rules.test.ts`

**Interfaces:**
- Consumes: `FieldErrors` type from `@/components/form-field`.
- Produces (all from `@/features/schedule/rules`):
  - `type Schedule = { hours: { days: number[]; opensAt: string; closesAt: string } | null; windows: { startsAt: string; endsAt: string; jobCap: number }[]; windowDays: number[] }`
  - `type FormWindow = { startsAt: string; endsAt: string; jobCap: string }`
  - `type ScheduleForm = { hoursDays: number[]; opensAt: string; closesAt: string; windows: FormWindow[]; windowDays: number[] }`
  - `WEEKDAYS: string[]` (`['Sun', …, 'Sat']`), `TIMES: string[]` (`'00:00'` … `'23:30'`), `MAX_WINDOWS = 8`
  - `formatTime(time: string): string`, `formatWindow(startsAt: string, endsAt: string): string`
  - `toForm(schedule: Schedule): ScheduleForm`, `toInput(form: ScheduleForm): Schedule`
  - `nextWindow(windows: FormWindow[]): FormWindow | null`
  - `validateSchedule(form: ScheduleForm): FieldErrors` (keys match the API's: `hours.closesAt`, `windows.1.startsAt`, `windowDays`, …)

- [ ] **Step 1: Write the failing tests**

Create `relay-web/src/features/schedule/rules.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  type FormWindow,
  formatTime,
  formatWindow,
  nextWindow,
  type ScheduleForm,
  TIMES,
  toForm,
  toInput,
  validateSchedule,
} from './rules'

function form(overrides: Partial<ScheduleForm> = {}): ScheduleForm {
  return {
    hoursDays: [1, 2, 3, 4, 5],
    opensAt: '07:00',
    closesAt: '18:00',
    windows: [
      { startsAt: '08:00', endsAt: '12:00', jobCap: '4' },
      { startsAt: '12:00', endsAt: '16:00', jobCap: '4' },
    ],
    windowDays: [1, 2, 3, 4, 5],
    ...overrides,
  }
}

const window = (startsAt: string, endsAt: string, jobCap = '4'): FormWindow => ({
  startsAt,
  endsAt,
  jobCap,
})

describe('formatTime', () => {
  it('reads like the board', () => {
    expect(formatTime('08:00')).toBe('8 AM')
    expect(formatTime('12:30')).toBe('12:30 PM')
    expect(formatTime('00:00')).toBe('12 AM')
    expect(formatWindow('08:00', '12:00')).toBe('8 AM–12 PM')
  })

  it('offers every half hour of the day', () => {
    expect(TIMES).toHaveLength(48)
    expect(TIMES[0]).toBe('00:00')
    expect(TIMES.at(-1)).toBe('23:30')
  })
})

describe('toForm and toInput', () => {
  it('round-trip a schedule, closed every day becoming no ticked days', () => {
    const schedule = {
      hours: null,
      windows: [{ startsAt: '08:00', endsAt: '12:00', jobCap: 2 }],
      windowDays: [2, 3],
    }
    const edited = toForm(schedule)
    expect(edited.hoursDays).toEqual([])
    expect(edited.windows).toEqual([window('08:00', '12:00', '2')])
    expect(toInput(edited)).toEqual(schedule)
  })

  it('sends hours when a day is ticked', () => {
    expect(toInput(form()).hours).toEqual({
      days: [1, 2, 3, 4, 5],
      opensAt: '07:00',
      closesAt: '18:00',
    })
  })
})

describe('nextWindow', () => {
  it('starts where the last window ends and runs as long', () => {
    expect(nextWindow([window('08:00', '12:00', '3')])).toEqual(window('12:00', '16:00', '3'))
  })

  it('stops at 11:30 PM, and offers nothing after a window that ends then', () => {
    expect(nextWindow([window('18:00', '22:00')])).toEqual(window('22:00', '23:30'))
    expect(nextWindow([window('20:00', '23:30')])).toBeNull()
  })

  it('suggests 8 AM–12 PM for the first window', () => {
    expect(nextWindow([])).toEqual(window('08:00', '12:00'))
  })
})

describe('validateSchedule', () => {
  it('accepts a good schedule', () => {
    expect(validateSchedule(form())).toEqual({})
  })

  it('needs closing after opening, unless closed every day', () => {
    expect(validateSchedule(form({ opensAt: '18:00', closesAt: '07:00' }))).toEqual({
      'hours.closesAt': ['Close after you open'],
    })
    expect(validateSchedule(form({ hoursDays: [], opensAt: '18:00', closesAt: '07:00' }))).toEqual(
      {},
    )
  })

  it('needs a whole-number cap from 1 to 20', () => {
    for (const jobCap of ['', '0', '21', '4.5', 'four']) {
      const errors = validateSchedule(form({ windows: [window('08:00', '12:00', jobCap)] }))
      expect(errors, jobCap).toEqual({ 'windows.0.jobCap': ['Enter a cap from 1 to 20 jobs'] })
    }
  })

  it('needs each window to end after it starts, and windows not to overlap', () => {
    expect(validateSchedule(form({ windows: [window('12:00', '08:00')] }))).toEqual({
      'windows.0.endsAt': ['End after the start'],
    })
    expect(
      validateSchedule(form({ windows: [window('11:00', '14:00'), window('08:00', '12:00')] })),
    ).toEqual({ 'windows.0.startsAt': ['Windows can’t overlap: 8 AM–12 PM and 11 AM–2 PM'] })
  })

  it('needs at least one window and one day for them', () => {
    expect(validateSchedule(form({ windows: [] }))).toEqual({
      windows: ['Add at least one arrival window'],
    })
    expect(validateSchedule(form({ windowDays: [] }))).toEqual({
      windowDays: ['Tick at least one day for the windows'],
    })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/features/schedule/rules.test.ts`
Expected: FAIL — `./rules` doesn't exist.

- [ ] **Step 3: Write the rules**

Create `relay-web/src/features/schedule/rules.ts`:

```ts
import type { FieldErrors } from '@/components/form-field'

// The Schedule page's form and the checks it runs before saving. The messages match
// relay-api's (src/modules/schedule/schedule.schemas.ts), so a field reads the same whichever
// side caught it.

export type Schedule = {
  hours: { days: number[]; opensAt: string; closesAt: string } | null // null: closed every day
  windows: { startsAt: string; endsAt: string; jobCap: number }[]
  windowDays: number[] // 0 = Sunday … 6 = Saturday
}

// The cap is kept as typed, so the field can be empty while someone edits it.
export type FormWindow = { startsAt: string; endsAt: string; jobCap: string }

export type ScheduleForm = {
  hoursDays: number[] // none ticked: closed every day
  opensAt: string
  closesAt: string
  windows: FormWindow[]
  windowDays: number[]
}

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
export const MAX_WINDOWS = 8

// Every half hour of the day: '00:00', '00:30' … '23:30'.
export const TIMES = Array.from(
  { length: 48 },
  (_, i) => `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`,
)

// '08:00' → '8 AM', '12:30' → '12:30 PM'
export function formatTime(time: string): string {
  const [hours, minutes] = time.split(':').map(Number)
  const suffix = hours < 12 ? 'AM' : 'PM'
  const hour = hours % 12 || 12
  return minutes ? `${hour}:${String(minutes).padStart(2, '0')} ${suffix}` : `${hour} ${suffix}`
}

// '8 AM–12 PM', the way the dispatch board labels a window.
export function formatWindow(startsAt: string, endsAt: string): string {
  return `${formatTime(startsAt)}–${formatTime(endsAt)}`
}

export function toForm(schedule: Schedule): ScheduleForm {
  return {
    hoursDays: schedule.hours?.days ?? [],
    opensAt: schedule.hours?.opensAt ?? '08:00',
    closesAt: schedule.hours?.closesAt ?? '17:00',
    windows: schedule.windows.map((window) => ({ ...window, jobCap: String(window.jobCap) })),
    windowDays: schedule.windowDays,
  }
}

// Only for a form validateSchedule passed.
export function toInput(form: ScheduleForm): Schedule {
  return {
    hours:
      form.hoursDays.length === 0
        ? null
        : { days: form.hoursDays, opensAt: form.opensAt, closesAt: form.closesAt },
    windows: form.windows.map((window) => ({ ...window, jobCap: Number(window.jobCap) })),
    windowDays: form.windowDays,
  }
}

// What "Add window" adds: it starts where the last window ends and runs as long, cut at
// 11:30 PM. Null when the last window already ends at 11:30 PM.
export function nextWindow(windows: FormWindow[]): FormWindow | null {
  const last = [...windows].sort((a, b) => a.startsAt.localeCompare(b.startsAt)).at(-1)
  if (!last) return { startsAt: '08:00', endsAt: '12:00', jobCap: '4' }
  const start = TIMES.indexOf(last.endsAt)
  if (start >= TIMES.length - 1) return null
  const length = start - TIMES.indexOf(last.startsAt)
  const end = Math.min(start + length, TIMES.length - 1)
  return { startsAt: TIMES[start], endsAt: TIMES[end], jobCap: last.jobCap }
}

// Field errors keyed like the API's: 'hours.closesAt', 'windows.1.startsAt', 'windowDays'.
export function validateSchedule(form: ScheduleForm): FieldErrors {
  const errors: FieldErrors = {}
  if (form.hoursDays.length > 0 && form.closesAt <= form.opensAt) {
    errors['hours.closesAt'] = ['Close after you open']
  }
  if (form.windows.length === 0) errors.windows = ['Add at least one arrival window']
  if (form.windows.length > MAX_WINDOWS) errors.windows = ['Keep it to 8 windows or fewer']
  form.windows.forEach((window, index) => {
    if (window.endsAt <= window.startsAt) errors[`windows.${index}.endsAt`] = ['End after the start']
    const cap = Number(window.jobCap)
    if (!/^\d+$/.test(window.jobCap.trim()) || cap < 1 || cap > 20) {
      errors[`windows.${index}.jobCap`] = ['Enter a cap from 1 to 20 jobs']
    }
  })
  const sorted = form.windows
    .map((window, index) => ({ ...window, index }))
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.index - b.index)
  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1]
    const current = sorted[i]
    if (current.startsAt < previous.endsAt) {
      errors[`windows.${current.index}.startsAt`] = [
        `Windows can’t overlap: ${formatWindow(previous.startsAt, previous.endsAt)} and ${formatWindow(current.startsAt, current.endsAt)}`,
      ]
    }
  }
  if (form.windowDays.length === 0) errors.windowDays = ['Tick at least one day for the windows']
  return errors
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/features/schedule/rules.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/features/schedule/rules.ts src/features/schedule/rules.test.ts
git commit -m "feat: schedule form rules, matching the API's checks"
```

---

### Task 4: Schedule page (relay-web)

**Files:**
- Create: `relay-web/src/features/schedule/api.ts`
- Create: `relay-web/src/routes/schedule.tsx`
- Modify: `relay-web/src/lib/socket.ts` (add `schedule.updated` to `RealtimeEvents`)
- Modify: `relay-web/src/router.tsx` (route `/schedule` in the owner/office children, after `/dashboard`)
- Modify: `relay-web/src/components/sidebar-links.ts` (Schedule link after Dispatch)
- Modify: `relay-web/src/routes/dashboard.tsx` (call `useScheduleLiveUpdates()`)

**Interfaces:**
- Consumes: everything from Task 3's `rules.ts`; `api` (`@/lib/api`), `ApiError`, `errorMessage`, `useSocketEvent`, `ConfirmDialog`/`Confirmation`, `Field`/`FieldMessages`/`FieldErrors`, `StaffPage`, UI `Button`, `Card*`, `Checkbox`, `Input`, `NativeSelect`.
- Produces: `useSchedule()`, `useCheckSchedule()`, `useSaveSchedule()`, `useScheduleLiveUpdates()` from `@/features/schedule/api`; `SchedulePage` from `@/routes/schedule`.

There are no component tests in this repo (only pure-function tests); this task is checked by typecheck, lint, build and the manual run in Step 7.

- [ ] **Step 1: Add the realtime event**

In `relay-web/src/lib/socket.ts`, add to `RealtimeEvents` after `'services.updated'`:

```ts
  'schedule.updated': { tenantId: string }
```

- [ ] **Step 2: Write the API hooks**

Create `relay-web/src/features/schedule/api.ts`:

```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { api } from '@/lib/api'
import { useSocketEvent } from '@/lib/socket'
import type { Schedule } from './rules'

const ScheduleResponse: z.ZodType<Schedule> = z.object({
  hours: z
    .object({ days: z.array(z.number()), opensAt: z.string(), closesAt: z.string() })
    .nullable(),
  windows: z.array(z.object({ startsAt: z.string(), endsAt: z.string(), jobCap: z.number() })),
  windowDays: z.array(z.number()),
})

const Check = z.object({ affectedJobs: z.number() })

const scheduleKey = ['schedule']
const boardsKey = ['dispatch', 'board'] // every day's board

export function useSchedule() {
  return useQuery({
    queryKey: scheduleKey,
    queryFn: () => api.get('/schedule', ScheduleResponse),
  })
}

// Saves nothing: how many upcoming jobs the change would touch.
export function useCheckSchedule() {
  return useMutation({
    mutationFn: (schedule: Schedule) => api.post('/schedule/check', schedule, Check),
  })
}

// Answers with the schedule as saved. Boards show the new windows.
export function useSaveSchedule() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (schedule: Schedule) => api.put('/schedule', schedule, ScheduleResponse),
    onSuccess: (schedule) => {
      queryClient.setQueryData(scheduleKey, schedule)
      queryClient.invalidateQueries({ queryKey: boardsKey })
    },
  })
}

// Someone else in the office changed the schedule.
export function useScheduleLiveUpdates() {
  const queryClient = useQueryClient()
  useSocketEvent('schedule.updated', () => {
    queryClient.invalidateQueries({ queryKey: scheduleKey })
    queryClient.invalidateQueries({ queryKey: boardsKey })
  })
}
```

- [ ] **Step 3: Write the page**

Create `relay-web/src/routes/schedule.tsx`:

```tsx
import { Plus, X } from 'lucide-react'
import { type ComponentProps, type FormEvent, useState } from 'react'
import { toast } from 'sonner'
import { type Confirmation, ConfirmDialog } from '@/components/confirm-dialog'
import { Field, type FieldErrors, FieldMessages } from '@/components/form-field'
import { StaffPage } from '@/components/staff-layout'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import {
  useCheckSchedule,
  useSaveSchedule,
  useSchedule,
  useScheduleLiveUpdates,
} from '@/features/schedule/api'
import {
  type FormWindow,
  formatTime,
  formatWindow,
  MAX_WINDOWS,
  nextWindow,
  type Schedule,
  type ScheduleForm,
  TIMES,
  toForm,
  toInput,
  validateSchedule,
  WEEKDAYS,
} from '@/features/schedule/rules'
import { ApiError } from '@/lib/api'
import { errorMessage } from '@/lib/errors'

// Owner and office set when they're open and which arrival windows customers can book, with
// how many jobs each window takes. One set of each, for the days ticked.
export function SchedulePage() {
  const schedule = useSchedule()
  useScheduleLiveUpdates()

  return (
    <StaffPage title="Schedule">
      <p className="text-sm text-muted-foreground">
        When you’re open and when customers can book a visit. Changes apply to new bookings. Jobs
        already booked keep their times.
      </p>

      {schedule.isPending && <p className="text-muted-foreground">Loading the schedule…</p>}
      {schedule.isError && (
        <div className="space-y-2 rounded-lg border border-destructive/30 p-4">
          <p className="text-sm text-destructive">{errorMessage(schedule.error)}</p>
          <Button variant="outline" size="sm" onClick={() => schedule.refetch()}>
            Try again
          </Button>
        </div>
      )}
      {/* A new saved schedule (here or from someone else) starts the form again. */}
      {schedule.data && (
        <ScheduleEditor key={JSON.stringify(schedule.data)} saved={schedule.data} />
      )}
    </StaffPage>
  )
}

function ScheduleEditor({ saved }: { saved: Schedule }) {
  const [form, setForm] = useState(() => toForm(saved))
  const [errors, setErrors] = useState<FieldErrors>({})
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const check = useCheckSchedule()
  const save = useSaveSchedule()
  const busy = check.isPending || save.isPending
  const next = nextWindow(form.windows)

  function change(changes: Partial<ScheduleForm>) {
    setForm((current) => ({ ...current, ...changes }))
  }

  function changeWindow(index: number, changes: Partial<FormWindow>) {
    setForm((current) => ({
      ...current,
      windows: current.windows.map((window, i) => (i === index ? { ...window, ...changes } : window)),
    }))
  }

  function onError(error: unknown) {
    if (error instanceof ApiError && error.code === 'validation_failed') setErrors(error.details)
    else toast.error(errorMessage(error))
  }

  function store(input: Schedule) {
    save.mutate(input, { onSuccess: () => toast.success('Schedule saved'), onError })
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    const found = validateSchedule(form)
    setErrors(found)
    if (Object.keys(found).length > 0) return
    const input = toInput(form)
    check.mutate(input, {
      onSuccess: ({ affectedJobs }) => {
        if (affectedJobs === 0) {
          store(input)
          return
        }
        setConfirmation({
          title: 'Upcoming jobs booked',
          message: `${affectedJobs} upcoming ${affectedJobs === 1 ? 'job is' : 'jobs are'} booked in windows you’re changing. They’ll keep their booked times. Move them on the Dispatch board if needed.`,
          confirmLabel: 'Save anyway',
          onConfirm: () => store(input),
        })
      },
      onError,
    })
  }

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Business hours</CardTitle>
          <CardDescription>
            When your office is open. Untick every day if you don’t keep office hours.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-3">
            <div className="w-36">
              <Field id="opens-at" label="Open" errors={errors['hours.opensAt']}>
                <TimeSelect
                  id="opens-at"
                  value={form.opensAt}
                  onChange={(event) => change({ opensAt: event.target.value })}
                />
              </Field>
            </div>
            <div className="w-36">
              <Field id="closes-at" label="Close" errors={errors['hours.closesAt']}>
                <TimeSelect
                  id="closes-at"
                  value={form.closesAt}
                  onChange={(event) => change({ closesAt: event.target.value })}
                />
              </Field>
            </div>
          </div>
          <DayPicker
            id="hours-days"
            legend="Open on"
            days={form.hoursDays}
            onChange={(hoursDays) => change({ hoursDays })}
            errors={errors['hours.days']}
          />
          {form.hoursDays.length === 0 && (
            <p className="text-sm text-muted-foreground">Closed every day</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Arrival windows</CardTitle>
          <CardDescription>
            Customers book a window, not an exact time. The cap is how many jobs a window takes,
            for the whole team.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {form.windows.map((window, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows have no id until saved, and every field is controlled
            <div key={index} className="flex flex-wrap items-end gap-3">
              <div className="w-32">
                <Field
                  id={`window-${index}-start`}
                  label="Start"
                  errors={errors[`windows.${index}.startsAt`]}
                >
                  <TimeSelect
                    id={`window-${index}-start`}
                    value={window.startsAt}
                    onChange={(event) => changeWindow(index, { startsAt: event.target.value })}
                  />
                </Field>
              </div>
              <div className="w-32">
                <Field
                  id={`window-${index}-end`}
                  label="End"
                  errors={errors[`windows.${index}.endsAt`]}
                >
                  <TimeSelect
                    id={`window-${index}-end`}
                    value={window.endsAt}
                    onChange={(event) => changeWindow(index, { endsAt: event.target.value })}
                  />
                </Field>
              </div>
              <div className="w-24">
                <Field
                  id={`window-${index}-cap`}
                  label="Cap (jobs)"
                  errors={errors[`windows.${index}.jobCap`]}
                >
                  <Input
                    id={`window-${index}-cap`}
                    inputMode="numeric"
                    autoComplete="off"
                    value={window.jobCap}
                    onChange={(event) => changeWindow(index, { jobCap: event.target.value })}
                  />
                </Field>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Remove ${formatWindow(window.startsAt, window.endsAt)}`}
                disabled={form.windows.length === 1}
                onClick={() => change({ windows: form.windows.filter((_, i) => i !== index) })}
              >
                <X />
              </Button>
            </div>
          ))}
          {errors.windows && <FieldMessages messages={errors.windows} />}
          <Button
            type="button"
            variant="outline"
            disabled={!next || form.windows.length >= MAX_WINDOWS}
            onClick={() => next && change({ windows: [...form.windows, next] })}
          >
            <Plus /> Add window
          </Button>
          <DayPicker
            id="window-days"
            legend="Windows on"
            days={form.windowDays}
            onChange={(windowDays) => change({ windowDays })}
            errors={errors.windowDays}
          />
        </CardContent>
      </Card>

      <Button type="submit" size="lg" disabled={busy}>
        {busy ? 'Saving…' : 'Save schedule'}
      </Button>
      <ConfirmDialog confirmation={confirmation} onClose={() => setConfirmation(null)} />
    </form>
  )
}

// Every half hour of the day. Field passes aria props through to the <select>.
function TimeSelect(props: ComponentProps<'select'>) {
  return (
    <NativeSelect {...props}>
      {TIMES.map((time) => (
        <option key={time} value={time}>
          {formatTime(time)}
        </option>
      ))}
    </NativeSelect>
  )
}

function DayPicker({
  id,
  legend,
  days,
  onChange,
  errors,
}: {
  id: string
  legend: string
  days: number[]
  onChange: (days: number[]) => void
  errors?: string[]
}) {
  return (
    <fieldset className="space-y-2" aria-describedby={errors ? `${id}-error` : undefined}>
      <legend className="text-sm font-medium">{legend}</legend>
      <div className="flex flex-wrap gap-4">
        {WEEKDAYS.map((name, weekday) => (
          <label key={name} className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={days.includes(weekday)}
              onCheckedChange={(checked) =>
                onChange(
                  checked
                    ? [...days, weekday].sort((a, b) => a - b)
                    : days.filter((day) => day !== weekday),
                )
              }
            />
            {name}
          </label>
        ))}
      </div>
      {errors && <FieldMessages id={`${id}-error`} messages={errors} />}
    </fieldset>
  )
}
```

- [ ] **Step 4: Wire the route, the sidebar link and live updates**

In `relay-web/src/router.tsx`, import `import { SchedulePage } from '@/routes/schedule'` with the other route imports (alphabetical: after `PhoneSignInPage`) and add after the `/dashboard` child:

```tsx
          { path: '/schedule', element: <SchedulePage /> },
```

In `relay-web/src/components/sidebar-links.ts`, add `Clock` to the lucide import (alphabetical: `CalendarDays, ChartColumn, Clock, Contact, …`) and insert after the Dispatch link:

```ts
  { to: '/schedule', label: 'Schedule', icon: Clock },
```

In `relay-web/src/routes/dashboard.tsx`, import `import { useScheduleLiveUpdates } from '@/features/schedule/api'` and add after `useCatalogLiveUpdates()`:

```ts
  useScheduleLiveUpdates() // new windows after a schedule change
```

- [ ] **Step 5: Typecheck, lint, test and build**

Run: `npm run typecheck && npm run lint && npm test && npm run build`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/features/schedule/api.ts src/routes/schedule.tsx src/lib/socket.ts src/router.tsx src/components/sidebar-links.ts src/routes/dashboard.tsx
git commit -m "feat: Schedule page for business hours, arrival windows and caps"
```

- [ ] **Step 7: Check it in the browser**

With relay-api (on `feat/schedule-settings`, `npm run dev`) and relay-web (`npm run dev`) running, sign in as an office user:
1. Sidebar shows **Schedule** after Dispatch; the page loads the seeded hours and windows.
2. Set a cap to `0`: "Enter a cap from 1 to 20 jobs" under it, nothing saved.
3. Book a job on the board in the last window, then remove that window on Schedule and save: the "Upcoming jobs booked" dialog appears; "Save anyway" saves and toasts "Schedule saved".
4. The board shows the job under "Other times", and the booking page offers the new windows.

---

### Task 5: Priority jobs pinned at the top of the board (relay-web)

**Files:**
- Modify: `relay-web/src/features/dispatch/place-jobs.ts` (add `priorityJobs`)
- Test: `relay-web/src/features/dispatch/place-jobs.test.ts`
- Create: `relay-web/src/features/dispatch/priority-strip.tsx`
- Modify: `relay-web/src/routes/dashboard.tsx` (render `PriorityStrip` after `DaySummary`)

**Interfaces:**
- Consumes: `Board`, `BoardJob` (`./api`; `BoardJob.windowLabel` is already sent by the board API, e.g. `'8 AM–12 PM'`), `JobCard` (`./job-card`).
- Produces: `priorityJobs(board: Board): BoardJob[]`; `PriorityStrip({ board, onOpen }: { board: Board; onOpen: (jobId: string) => void })`.

- [ ] **Step 1: Write the failing test**

In `relay-web/src/features/dispatch/place-jobs.test.ts`, add `priorityJobs` to the `./place-jobs` import and append:

```ts
describe('priorityJobs', () => {
  it('lists the day’s priority jobs still to do, in the board’s order', () => {
    const jobs = [
      job({ id: 'urgent-morning', priority: true }),
      job({ id: 'urgent-afternoon', priority: true, windowId: 'afternoon' }),
      job({ id: 'urgent-done', priority: true, status: 'done' }),
      job({ id: 'routine' }),
    ]

    expect(priorityJobs(board(jobs)).map((j) => j.id)).toEqual([
      'urgent-morning',
      'urgent-afternoon',
    ])
  })

  it('is empty on a day without priority jobs', () => {
    expect(priorityJobs(board([job({ id: 'routine' })]))).toEqual([])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/features/dispatch/place-jobs.test.ts`
Expected: FAIL — `priorityJobs` is not exported.

- [ ] **Step 3: Write `priorityJobs`**

In `relay-web/src/features/dispatch/place-jobs.ts`, after `placeJobs`:

```ts
// The day's PRIORITY jobs still to do, for the Priority section at the top of the board. The
// API sends PRIORITY first by window start, so the order is kept.
export function priorityJobs(board: Board): BoardJob[] {
  return board.jobs.filter((job) => job.priority && job.status !== 'done')
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/features/dispatch/place-jobs.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the Priority section**

Create `relay-web/src/features/dispatch/priority-strip.tsx`:

```tsx
import type { Board } from './api'
import { JobCard } from './job-card'
import { priorityJobs } from './place-jobs'

// The day's PRIORITY jobs above the board, so none sits below the fold in a later window. They
// also stay in their own cell, where they're dragged and counted; these cards only open the job.
export function PriorityStrip({
  board,
  onOpen,
}: {
  board: Board
  onOpen: (jobId: string) => void
}) {
  const jobs = priorityJobs(board)
  if (jobs.length === 0) return null
  const technicians = new Map(
    board.technicians.map((technician) => [technician.id, technician.name]),
  )

  return (
    <section
      aria-labelledby="priority-heading"
      className="space-y-2 rounded-lg border border-red-200 bg-red-50/40 p-3"
    >
      <h2 id="priority-heading" className="text-sm font-semibold text-red-800">
        Priority · {jobs.length} {jobs.length === 1 ? 'job' : 'jobs'}
      </h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {jobs.map((job) => (
          <div key={job.id} className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">{job.windowLabel}</p>
            <JobCard
              job={job}
              onOpen={onOpen}
              technicianName={job.technicianId ? (technicians.get(job.technicianId) ?? '') : ''}
            />
          </div>
        ))}
      </div>
    </section>
  )
}
```

- [ ] **Step 6: Show it on the dashboard**

In `relay-web/src/routes/dashboard.tsx`, import `import { PriorityStrip } from '@/features/dispatch/priority-strip'` (after the `JobDrawer` import) and change

```tsx
          <DaySummary board={board.data} />
```

to

```tsx
          <DaySummary board={board.data} />
          <PriorityStrip board={board.data} onOpen={(id) => update({ job: id })} />
```

- [ ] **Step 7: Typecheck, lint, test and build**

Run: `npm run typecheck && npm run lint && npm test && npm run build`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/features/dispatch/place-jobs.ts src/features/dispatch/place-jobs.test.ts src/features/dispatch/priority-strip.tsx src/routes/dashboard.tsx
git commit -m "feat: priority jobs pinned at the top of the dispatch board"
```

- [ ] **Step 9: Check it in the browser**

Book a priority job (tick "vulnerable occupant" or priority service) in the last window of a day with other jobs. On the board for that day: a red "Priority · 1 job" section above the grid shows it with its window label; clicking opens the drawer; the job is still in its cell and can be dragged. Mark it done: it leaves the section. On a phone-width window the section sits above the window list.
