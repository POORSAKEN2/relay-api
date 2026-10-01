# Technician Job List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A signed-in technician sees the jobs the office assigned to them (today and the next 6 days) and opens one to see everything for the visit, with live updates when the office changes something.

**Architecture:** A new relay-api module `technician-jobs` with three technician-only routes under `/api/my-jobs`. The list has its own query; the job page reuses the dispatch module's queries and keeps only what a technician needs. The web app's `/jobs` and `/jobs/:jobId` pages load these and reload on the existing live events (`job.assigned`, `job.status_changed`, `booking.created`).

**Tech Stack:** relay-api: Express 5, Drizzle ORM, PostgreSQL 18, Zod, Vitest + Supertest. relay-web: React 19, React Router, TanStack Query, Zod, Socket.IO client, Tailwind v4, Vitest.

**Spec:** `relay-api/docs/superpowers/specs/2026-10-01-technician-job-list-design.md`

## Global Constraints

- Two repos side by side, `relay-api` and `relay-web`. Work on branch `feat/technician-job-list` in both (already created from `main`; the spec is committed in relay-api).
- Lean, plain code a junior developer can debug without AI. Short "why" comments above functions, like the code around it.
- Commit messages: lowercase conventional style (`feat: …`, `docs: …`). No `Co-Authored-By` trailer.
- Run Biome only on the files you touched: `npx biome check --write <paths>`.
- Days shown: today and the next 6 days (7 in all), in the contractor's time zone (`tenants.timezone`).
- Statuses shown: `booked`, `en_route`, `in_progress`, `no_access`, `done`. Never `held`, `expired`, `cancelled`.
- Exact copy:
  - 404 on the job page and photo route: `This job isn’t assigned to you anymore.`
  - 404 for a photo not on the job: `That photo isn’t on this job.`
  - Empty list: `No jobs assigned to you for the next 7 days.`
  - List failed: `We couldn’t load your jobs.` and a `Try again` button
  - Back link: `Back to your jobs`
  - Buttons: `Call`, `Text`, `Open in Maps`
  - Vulnerable line: `Someone vulnerable is home without heat or cooling.`
  - Photo alt text: `Homeowner’s upload 1` (2, 3)
- Office routes and the dispatch board do not change behaviour.

## Files

relay-api:
- Create `src/modules/technician-jobs/technician-jobs.queries.ts`: the list query and the visible statuses.
- Create `src/modules/technician-jobs/technician-jobs.service.ts`: list grouping, the "is it yours" check, the job page and photo.
- Create `src/modules/technician-jobs/technician-jobs.routes.ts`: the three routes.
- Create `src/modules/technician-jobs/technician-jobs.test.ts`.
- Modify `src/modules/dispatch/dispatch.queries.ts`: export `local()` so the new query can use it.
- Modify `src/app.ts`: mount the routes.
- Modify `test/helpers.ts`: `signInTechnician()`.

relay-web:
- Create `src/features/technician-jobs/api.ts`: schemas, `useMyJobs`, `useMyJob`, `useMyJobsLiveUpdates`.
- Create `src/features/technician-jobs/maps.ts` + `maps.test.ts`: the Maps link.
- Create `src/features/technician-jobs/job-list.tsx`: the list.
- Create `src/features/technician-jobs/job-details.tsx`: the job page body.
- Modify `src/routes/technician-home.tsx`, `src/routes/job.tsx`, `src/router.tsx` (`/jobs/:token` becomes `/jobs/:jobId`).

---

### Task 1: API — the technician's job list

**Files:**
- Modify: `relay-api/test/helpers.ts` (imports at the top; new function after `signIn`)
- Modify: `relay-api/src/modules/dispatch/dispatch.queries.ts:24` (`function local` → `export function local`)
- Create: `relay-api/src/modules/technician-jobs/technician-jobs.queries.ts`
- Create: `relay-api/src/modules/technician-jobs/technician-jobs.service.ts`
- Create: `relay-api/src/modules/technician-jobs/technician-jobs.routes.ts`
- Modify: `relay-api/src/app.ts` (import and mount `technicianJobsRoutes`)
- Test: `relay-api/src/modules/technician-jobs/technician-jobs.test.ts`

**Interfaces:**
- Consumes: `requireRole` (`src/middleware/auth.ts`), `tenantOf` (`src/modules/booking/booking.service.ts`), `formatDay`, `formatWindow` (`src/lib/labels.ts`), `accounts.signInWithCode`, `accounts.hashCode`, test helpers `createShop`, `createJob`, `resetDb`.
- Produces:
  - `signInTechnician(technician: { id: string; phone: string | null }): Promise<string>` (Cookie header) in `test/helpers.ts`
  - `export function local(column: PgColumn, format: string): SQL<string>` in dispatch.queries.ts
  - `VISIBLE_STATUSES`, `listTechnicianJobs(tenantId, technicianId, days)` in technician-jobs.queries.ts
  - `listMyJobs(user: SessionUser): Promise<{ days: { date: string; label: string; jobs: MyJobCard[] }[] }>` in technician-jobs.service.ts, where a card is `{ id, status, priority, windowLabel, customerName, street, city, serviceName }`
  - `technicianJobsRoutes` (Express Router) with `GET /my-jobs`

- [ ] **Step 1: Add the technician sign-in test helper**

In `relay-api/test/helpers.ts`, add `signInCodes` to the schema import list (alphabetical, after `services`), then add after `signIn`:

```ts
// Starts a technician's session the way a texted code does, without the rate-limited route.
// Returns the Cookie header for later requests.
export async function signInTechnician(technician: {
  id: string
  phone: string | null
}): Promise<string> {
  await db.insert(signInCodes).values({
    userId: technician.id,
    codeHash: accounts.hashCode('123456'),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  })
  const { token } = await accounts.signInWithCode(technician.phone!, '123456')
  return `${SESSION_COOKIE}=${token}`
}
```

- [ ] **Step 2: Write the failing tests**

Create `relay-api/src/modules/technician-jobs/technician-jobs.test.ts`:

```ts
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run (in `relay-api`): `npx vitest run src/modules/technician-jobs/technician-jobs.test.ts`
Expected: FAIL. The first two tests get `404` (no `/api/my-jobs` route yet); the access test gets `404` instead of `401`.

- [ ] **Step 4: Export the local-time helper**

In `relay-api/src/modules/dispatch/dispatch.queries.ts`, change:

```ts
function local(column: PgColumn, format: string): SQL<string> {
```

to:

```ts
// A timestamp as the contractor's wall clock, e.g. 'YYYY-MM-DD' or 'HH24:MI:SS'. Needs
// `tenants` joined. Also used by the technician job list.
export function local(column: PgColumn, format: string): SQL<string> {
```

- [ ] **Step 5: Add the list query**

Create `relay-api/src/modules/technician-jobs/technician-jobs.queries.ts`:

```ts
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../../db/client.ts'
import { customers, jobs, properties, services, tenants } from '../../db/schema.ts'
import { local } from '../dispatch/dispatch.queries.ts'

// Tenant-scoped: every query takes tenantId first. The job page reuses the dispatch module's
// queries; only the list needs its own.

// The statuses a technician sees: assigned and not called off. 'held', 'expired' and
// 'cancelled' never show.
export const VISIBLE_STATUSES = ['booked', 'en_route', 'in_progress', 'no_access', 'done'] as const

// A technician's jobs from the start of the contractor's local today, for `days` days, in the
// order the list shows them: by day, done last, then by window, PRIORITY first, oldest first.
export function listTechnicianJobs(tenantId: string, technicianId: string, days: number) {
  const today = sql`(now() at time zone ${tenants.timezone})::date`
  return db
    .select({
      id: jobs.id,
      status: jobs.status,
      priority: jobs.priority,
      date: local(jobs.windowStartsAt, 'YYYY-MM-DD'),
      localStart: local(jobs.windowStartsAt, 'HH24:MI:SS'),
      localEnd: local(jobs.windowEndsAt, 'HH24:MI:SS'),
      customerName: customers.name,
      street: properties.street,
      city: properties.city,
      serviceName: services.name,
    })
    .from(jobs)
    .innerJoin(tenants, eq(tenants.id, jobs.tenantId))
    .innerJoin(customers, eq(customers.id, jobs.customerId))
    .innerJoin(properties, eq(properties.id, jobs.propertyId))
    .innerJoin(services, eq(services.id, jobs.serviceId))
    .where(
      and(
        eq(jobs.tenantId, tenantId),
        eq(jobs.technicianId, technicianId),
        inArray(jobs.status, [...VISIBLE_STATUSES]),
        sql`${jobs.windowStartsAt} >= ${today}::timestamp at time zone ${tenants.timezone}`,
        sql`${jobs.windowStartsAt} < (${today} + ${days}::int)::timestamp at time zone ${tenants.timezone}`,
      ),
    )
    .orderBy(
      local(jobs.windowStartsAt, 'YYYY-MM-DD'),
      sql`${jobs.status} = 'done'`,
      asc(jobs.windowStartsAt),
      desc(jobs.priority),
      asc(jobs.createdAt),
    )
}
```

- [ ] **Step 6: Add the service**

Create `relay-api/src/modules/technician-jobs/technician-jobs.service.ts`:

```ts
import { formatDay, formatWindow } from '../../lib/labels.ts'
import type { SessionUser } from '../accounts/accounts.service.ts'
import { tenantOf } from '../booking/booking.service.ts'
import * as queries from './technician-jobs.queries.ts'

// What a signed-in technician sees: only the jobs the office assigned to them. Read-only for
// now; status buttons, photos and payment come in later parts of module 8.

const DAYS_SHOWN = 7 // today and the next 6 days

// The technician's jobs, grouped by local day. Days without jobs are left out.
export async function listMyJobs(user: SessionUser) {
  const rows = await queries.listTechnicianJobs(tenantOf(user), user.id, DAYS_SHOWN)
  const days: {
    date: string
    label: string
    jobs: {
      id: string
      status: (typeof rows)[number]['status']
      priority: boolean
      windowLabel: string
      customerName: string
      street: string
      city: string
      serviceName: string
    }[]
  }[] = []
  for (const { date, localStart, localEnd, ...job } of rows) {
    // Rows come sorted by day, so a new date always starts a new group.
    if (days.at(-1)?.date !== date) days.push({ date, label: formatDay(date), jobs: [] })
    days.at(-1)!.jobs.push({ ...job, windowLabel: formatWindow(localStart, localEnd) })
  }
  return { days }
}
```

- [ ] **Step 7: Add the route and mount it**

Create `relay-api/src/modules/technician-jobs/technician-jobs.routes.ts`:

```ts
import { Router } from 'express'
import { requireRole } from '../../middleware/auth.ts'
import * as technicianJobs from './technician-jobs.service.ts'

// The technician's side of jobs. Who they are comes from the session, never the request.
export const technicianJobsRoutes = Router()

const technician = requireRole('technician')

technicianJobsRoutes.get('/my-jobs', technician, async (req, res) => {
  res.json(await technicianJobs.listMyJobs(req.user!))
})
```

In `relay-api/src/app.ts`, add the import after `teamRoutes`'s:

```ts
import { technicianJobsRoutes } from './modules/technician-jobs/technician-jobs.routes.ts'
```

and add `technicianJobsRoutes,` to the routes list after `teamRoutes,`.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run src/modules/technician-jobs/technician-jobs.test.ts`
Expected: PASS, 3 tests.

Run: `npm test`
Expected: PASS.

- [ ] **Step 9: Typecheck, lint, commit**

```bash
npm run typecheck
npx biome check --write test/helpers.ts src/app.ts src/modules/dispatch/dispatch.queries.ts src/modules/technician-jobs/technician-jobs.queries.ts src/modules/technician-jobs/technician-jobs.service.ts src/modules/technician-jobs/technician-jobs.routes.ts src/modules/technician-jobs/technician-jobs.test.ts
git add test/helpers.ts src/app.ts src/modules/dispatch/dispatch.queries.ts src/modules/technician-jobs
git commit -m "feat: list a technician's assigned jobs"
```

---

### Task 2: API — the job page and its photos

**Files:**
- Modify: `relay-api/src/modules/technician-jobs/technician-jobs.service.ts`
- Modify: `relay-api/src/modules/technician-jobs/technician-jobs.routes.ts`
- Test: `relay-api/src/modules/technician-jobs/technician-jobs.test.ts`

**Interfaces:**
- Consumes: from `src/modules/dispatch/dispatch.queries.ts`: `findJobDetail(tenantId, jobId)`, `listNotes(tenantId, jobId)`, `listJobPhotos(tenantId, jobId)`, `findJobPhoto(tenantId, jobId, photoId)`; `JobParams`, `JobPhotoParams` from `dispatch.schemas.ts`; `sendPhoto` from `src/lib/send-photo.ts`; `HttpError`; `VISIBLE_STATUSES` (Task 1).
- Produces:
  - `getMyJob(user, jobId)` → `{ job, notes, photos }` with `job` exactly `{ id, status, priority, problem, systemType, vulnerableOccupant, dateLabel, windowLabel, service: { name }, customer: { name, phone }, property: { street, unit, city, state, zip, notes, equipmentBrand, equipmentYear } }`, `notes` as the board's (`{ id, body, authorName, createdAt }`), `photos` `{ id, url }` with `url` = `/my-jobs/<jobId>/photos/<photoId>`
  - `getMyJobPhoto(user, jobId, photoId)` → `{ contentType, data }`
  - Routes `GET /my-jobs/:jobId` and `GET /my-jobs/:jobId/photos/:photoId`

- [ ] **Step 1: Write the failing tests**

In `relay-api/src/modules/technician-jobs/technician-jobs.test.ts`:

Add to the imports:

```ts
import { randomUUID } from 'node:crypto'
import { db } from '../../db/client.ts'
import { bookingDrafts, bookingPhotos } from '../../db/schema.ts'
```

and `type Shop,` to the helpers import list.

Add below `phoenixDay`:

```ts
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
```

Append:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/modules/technician-jobs/technician-jobs.test.ts`
Expected: the 4 new tests FAIL with `404` where `200`/`400`/`403` is expected (no `/my-jobs/:jobId` route yet); the 3 list tests still PASS.

- [ ] **Step 3: Add the job page and photo to the service**

In `relay-api/src/modules/technician-jobs/technician-jobs.service.ts`, add to the imports:

```ts
import { HttpError } from '../../lib/http-error.ts'
import * as dispatch from '../dispatch/dispatch.queries.ts'
```

Add after `const DAYS_SHOWN`:

```ts
const NOT_YOURS = 'This job isn’t assigned to you anymore.'
```

Append:

```ts
// The job, if it's this technician's and still shows on their list. Anything else (another
// technician's, unassigned, another contractor's, cancelled) gets the same 404, so the answer
// doesn't reveal which jobs exist.
async function findMyJob(user: SessionUser, jobId: string) {
  const job = await dispatch.findJobDetail(tenantOf(user), jobId)
  const visible = (queries.VISIBLE_STATUSES as readonly string[]).includes(job?.status ?? '')
  if (!job || job.technicianId !== user.id || !visible) {
    throw new HttpError(404, 'not_found', NOT_YOURS)
  }
  return job
}

// Everything the technician needs for the visit. Office-only parts (the schedule, allowed
// status changes, the customer's email, where the booking came from) are left out.
export async function getMyJob(user: SessionUser, jobId: string) {
  const job = await findMyJob(user, jobId)
  const tenantId = tenantOf(user)
  const [notes, photos] = await Promise.all([
    dispatch.listNotes(tenantId, jobId),
    dispatch.listJobPhotos(tenantId, jobId),
  ])
  return {
    job: {
      id: job.id,
      status: job.status,
      priority: job.priority,
      problem: job.problem,
      systemType: job.systemType,
      vulnerableOccupant: job.vulnerableOccupant,
      dateLabel: formatDay(job.date),
      windowLabel: formatWindow(job.localStart, job.localEnd),
      service: { name: job.service.name },
      customer: { name: job.customer.name, phone: job.customer.phone },
      property: job.property,
    },
    notes,
    // `url` is a path under the API; the web app puts the API's address in front.
    photos: photos.map((photo) => ({ id: photo.id, url: `/my-jobs/${jobId}/photos/${photo.id}` })),
  }
}

// A photo the homeowner added while booking one of this technician's jobs.
export async function getMyJobPhoto(user: SessionUser, jobId: string, photoId: string) {
  await findMyJob(user, jobId)
  const photo = await dispatch.findJobPhoto(tenantOf(user), jobId, photoId)
  if (!photo) throw new HttpError(404, 'not_found', 'That photo isn’t on this job.')
  return photo
}
```

- [ ] **Step 4: Add the routes**

In `relay-api/src/modules/technician-jobs/technician-jobs.routes.ts`, add to the imports:

```ts
import { sendPhoto } from '../../lib/send-photo.ts'
import { JobParams, JobPhotoParams } from '../dispatch/dispatch.schemas.ts'
```

Append:

```ts
technicianJobsRoutes.get('/my-jobs/:jobId', technician, async (req, res) => {
  const { jobId } = JobParams.parse(req.params)
  res.json(await technicianJobs.getMyJob(req.user!, jobId))
})

technicianJobsRoutes.get('/my-jobs/:jobId/photos/:photoId', technician, async (req, res) => {
  const { jobId, photoId } = JobPhotoParams.parse(req.params)
  sendPhoto(res, await technicianJobs.getMyJobPhoto(req.user!, jobId, photoId))
})
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/modules/technician-jobs/technician-jobs.test.ts`
Expected: PASS, 7 tests.

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
npm run typecheck
npx biome check --write src/modules/technician-jobs/technician-jobs.service.ts src/modules/technician-jobs/technician-jobs.routes.ts src/modules/technician-jobs/technician-jobs.test.ts
git add src/modules/technician-jobs
git commit -m "feat: show a technician one of their jobs and its photos"
```

---

### Task 3: Web — the job list on `/jobs`, with live updates

**Files:**
- Create: `relay-web/src/features/technician-jobs/api.ts`
- Create: `relay-web/src/features/technician-jobs/job-list.tsx`
- Modify: `relay-web/src/routes/technician-home.tsx` (whole file)

**Interfaces:**
- Consumes: `GET /api/my-jobs` and `GET /api/my-jobs/:jobId` (Tasks 1–2); `JOB_STATUSES`, `SYSTEM_TYPES` from `@/features/dispatch/api`; `STATUS` from `@/features/dispatch/labels`; `useSocketEvent` from `@/lib/socket`; `api` from `@/lib/api`; `env` from `@/lib/env`; `errorMessage` from `@/lib/errors`.
- Produces:
  - `useMyJobs()`, `useMyJob(jobId: string)`, `useMyJobsLiveUpdates()`, `type MyJob` in `features/technician-jobs/api.ts`
  - `JobList()` in `features/technician-jobs/job-list.tsx`

- [ ] **Step 1: Add the API hooks**

Create `relay-web/src/features/technician-jobs/api.ts`:

```ts
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { JOB_STATUSES, SYSTEM_TYPES } from '@/features/dispatch/api'
import { api } from '@/lib/api'
import { env } from '@/lib/env'
import { useSocketEvent } from '@/lib/socket'

// A technician's own jobs. The API only ever returns jobs assigned to the signed-in technician.

const MyJobs = z.object({
  days: z.array(
    z.object({
      date: z.string(), // '2030-01-08'
      label: z.string(), // 'Tue, Jan 8'
      jobs: z.array(
        z.object({
          id: z.string(),
          status: z.enum(JOB_STATUSES),
          priority: z.boolean(),
          windowLabel: z.string(), // '8 AM–12 PM'
          customerName: z.string(),
          street: z.string(),
          city: z.string(),
          serviceName: z.string(),
        }),
      ),
    }),
  ),
})

const MyJob = z.object({
  job: z.object({
    id: z.string(),
    status: z.enum(JOB_STATUSES),
    priority: z.boolean(),
    problem: z.string(),
    systemType: z.enum(SYSTEM_TYPES),
    vulnerableOccupant: z.boolean(),
    dateLabel: z.string(),
    windowLabel: z.string(),
    service: z.object({ name: z.string() }),
    customer: z.object({ name: z.string(), phone: z.string().nullable() }),
    property: z.object({
      street: z.string(),
      unit: z.string().nullable(),
      city: z.string(),
      state: z.string(),
      zip: z.string(),
      notes: z.string().nullable(), // access notes, e.g. a gate code
      equipmentBrand: z.string().nullable(),
      equipmentYear: z.number().nullable(),
    }),
  }),
  notes: z.array(
    z.object({
      id: z.string(),
      body: z.string(),
      authorName: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
  // `url` arrives as a path under the API; made loadable here, like other photos.
  photos: z.array(
    z.object({
      id: z.string(),
      url: z.string().transform((path) => `${env.VITE_API_URL}${path}`),
    }),
  ),
})
export type MyJob = z.infer<typeof MyJob>

const myJobsKey = ['technician-jobs']

// Today's jobs and the next 6 days', grouped by day.
export function useMyJobs() {
  return useQuery({
    queryKey: [...myJobsKey, 'list'],
    queryFn: () => api.get('/my-jobs', MyJobs),
  })
}

export function useMyJob(jobId: string) {
  return useQuery({
    queryKey: [...myJobsKey, 'job', jobId],
    queryFn: () => api.get(`/my-jobs/${jobId}`, MyJob),
  })
}

// The office assigned, moved, booked or changed a job: reload the list and any open job.
// The events carry only a job id and days, so every change reloads; a shop's day is small.
export function useMyJobsLiveUpdates() {
  const queryClient = useQueryClient()
  const reload = () => queryClient.invalidateQueries({ queryKey: myJobsKey })
  useSocketEvent('booking.created', reload)
  useSocketEvent('job.assigned', reload)
  useSocketEvent('job.status_changed', reload)
}
```

- [ ] **Step 2: Add the list**

Create `relay-web/src/features/technician-jobs/job-list.tsx`:

```tsx
import { cn } from 'cn'
import { ChevronRight, Loader2 } from 'lucide-react'
import { Link } from 'react-router'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { STATUS } from '@/features/dispatch/labels'
import { errorMessage } from '@/lib/errors'
import { useMyJobs } from './api'

// The technician's jobs, today first, then the next 6 days. Each card opens the job.
export function JobList() {
  const list = useMyJobs()

  if (list.isPending) {
    return (
      <p className="flex items-center gap-2 text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Loading your jobs…
      </p>
    )
  }
  if (list.isError) {
    return (
      <div className="space-y-2">
        <p className="font-medium">We couldn’t load your jobs.</p>
        <p className="text-sm text-muted-foreground">{errorMessage(list.error)}</p>
        <Button variant="outline" onClick={() => list.refetch()}>
          Try again
        </Button>
      </div>
    )
  }
  if (list.data.days.length === 0) {
    return <p className="text-muted-foreground">No jobs assigned to you for the next 7 days.</p>
  }

  return (
    <div className="space-y-6">
      {list.data.days.map((day) => (
        <section key={day.date} className="space-y-2">
          <h2 className="text-sm font-semibold text-muted-foreground">{day.label}</h2>
          <ul className="space-y-2">
            {day.jobs.map((job) => (
              <li key={job.id}>
                <Link
                  to={`/jobs/${job.id}`}
                  className={cn(
                    'flex items-center gap-3 rounded-xl bg-card p-4 shadow-sm outline-none transition-shadow hover:shadow-md focus-visible:ring-3 focus-visible:ring-ring/50',
                    job.status === 'done' && 'opacity-60',
                  )}
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-semibold">{job.windowLabel}</span>
                      {job.priority && <Badge className="bg-red-600 text-white">PRIORITY</Badge>}
                      <Badge className={STATUS[job.status].chip}>{STATUS[job.status].label}</Badge>
                    </div>
                    <p className="font-medium">{job.customerName}</p>
                    <p className="truncate text-sm text-muted-foreground">
                      {job.street}, {job.city} · {job.serviceName}
                    </p>
                  </div>
                  <ChevronRight className="size-5 shrink-0 text-muted-foreground" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
```

- [ ] **Step 3: Show it on `/jobs`**

Replace `relay-web/src/routes/technician-home.tsx` with:

```tsx
import { PageShell } from '@/components/page-shell'
import { SignOutButton } from '@/features/auth/sign-out-button'
import { useMyJobsLiveUpdates } from '@/features/technician-jobs/api'
import { JobList } from '@/features/technician-jobs/job-list'

// Where a technician lands after signing in: the jobs the office assigned to them.
export function TechnicianHomePage() {
  useMyJobsLiveUpdates()

  return (
    <PageShell title="Your jobs" actions={<SignOutButton to="/sign-in/phone" />}>
      <JobList />
    </PageShell>
  )
}
```

- [ ] **Step 4: Typecheck, test, lint, commit**

```bash
npm run typecheck
npm test
npx biome check --write src/features/technician-jobs/api.ts src/features/technician-jobs/job-list.tsx src/routes/technician-home.tsx
git add src/features/technician-jobs src/routes/technician-home.tsx
git commit -m "feat: show technicians their assigned jobs"
```

Expected: typecheck prints nothing; tests pass; Biome reports no errors.

---

### Task 4: Web — the job page on `/jobs/:jobId`

**Files:**
- Create: `relay-web/src/features/technician-jobs/maps.ts`
- Test: `relay-web/src/features/technician-jobs/maps.test.ts`
- Create: `relay-web/src/features/technician-jobs/job-details.tsx`
- Modify: `relay-web/src/routes/job.tsx` (whole file)
- Modify: `relay-web/src/router.tsx` (the `/jobs/:token` route)

**Interfaces:**
- Consumes: `useMyJob`, `useMyJobsLiveUpdates`, `type MyJob` (Task 3); `STATUS`, `SYSTEM_TYPE_LABELS` from `@/features/dispatch/labels`; `buttonVariants` from `@/components/ui/button`; `errorMessage`.
- Produces: `mapsUrl(address: { street: string; unit: string | null; city: string; state: string; zip: string }): string`; `JobDetails({ jobId })`; route `/jobs/:jobId`.

- [ ] **Step 1: Write the failing Maps test**

Create `relay-web/src/features/technician-jobs/maps.test.ts`:

```ts
import { expect, it } from 'vitest'
import { mapsUrl } from './maps'

const palmSt = { street: '12 Palm St', unit: null, city: 'Phoenix', state: 'AZ', zip: '85004' }

it('searches Google Maps for the address', () => {
  expect(mapsUrl(palmSt)).toBe(
    'https://www.google.com/maps/search/?api=1&query=12%20Palm%20St%2C%20Phoenix%2C%20AZ%2085004',
  )
})

it('includes the unit when there is one', () => {
  expect(mapsUrl({ ...palmSt, unit: 'Apt 2' })).toBe(
    'https://www.google.com/maps/search/?api=1&query=12%20Palm%20St%2C%20Apt%202%2C%20Phoenix%2C%20AZ%2085004',
  )
})
```

- [ ] **Step 2: Run it to verify it fails**

Run (in `relay-web`): `npx vitest run src/features/technician-jobs/maps.test.ts`
Expected: FAIL, `Cannot find module './maps'`.

- [ ] **Step 3: Write the Maps helper**

Create `relay-web/src/features/technician-jobs/maps.ts`:

```ts
// A Google Maps search for an address. Phones open it in their Maps app.
export function mapsUrl(address: {
  street: string
  unit: string | null
  city: string
  state: string
  zip: string
}): string {
  const line = [address.street, address.unit, address.city, `${address.state} ${address.zip}`]
    .filter(Boolean)
    .join(', ')
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(line)}`
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/features/technician-jobs/maps.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Add the job page body**

Create `relay-web/src/features/technician-jobs/job-details.tsx`:

```tsx
import { cn } from 'cn'
import { ArrowLeft, Loader2, MapPin, MessageSquare, Phone } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { STATUS, SYSTEM_TYPE_LABELS } from '@/features/dispatch/labels'
import { errorMessage } from '@/lib/errors'
import { useMyJob } from './api'
import { mapsUrl } from './maps'

const noteTime = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})

// Everything a technician needs for one visit. Read-only for now. A job that stops being
// theirs (reassigned, cancelled) answers 404, which shows the API's message and a way back.
export function JobDetails({ jobId }: { jobId: string }) {
  const detail = useMyJob(jobId)

  if (detail.isPending) {
    return (
      <p className="flex items-center gap-2 text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Loading the job…
      </p>
    )
  }
  if (detail.isError) {
    return (
      <div className="space-y-3">
        <p>{errorMessage(detail.error)}</p>
        <BackLink />
      </div>
    )
  }

  const { job, notes, photos } = detail.data
  const { customer, property } = job
  const status = STATUS[job.status]

  return (
    <div className="space-y-4">
      <BackLink />

      <Section>
        <div className="flex flex-wrap items-center gap-1.5">
          {job.priority && <Badge className="bg-red-600 text-white">PRIORITY</Badge>}
          <Badge className={status.chip}>{status.label}</Badge>
        </div>
        <h2 className="text-xl font-semibold">{customer.name}</h2>
        <p className="text-sm text-muted-foreground">
          {job.service.name} · {job.dateLabel}, {job.windowLabel}
        </p>
        {customer.phone && (
          <div className="grid grid-cols-2 gap-2 pt-2">
            <a href={`tel:${customer.phone}`} className={cn(buttonVariants(), 'h-11')}>
              <Phone />
              Call
            </a>
            <a
              href={`sms:${customer.phone}`}
              className={cn(buttonVariants({ variant: 'outline' }), 'h-11')}
            >
              <MessageSquare />
              Text
            </a>
          </div>
        )}
      </Section>

      <Section title="Address">
        <p>
          {property.street}
          {property.unit && `, ${property.unit}`}
          <br />
          {property.city}, {property.state} {property.zip}
        </p>
        {property.notes && <p className="text-muted-foreground">Access: {property.notes}</p>}
        <a
          href={mapsUrl(property)}
          target="_blank"
          rel="noreferrer"
          className={cn(buttonVariants({ variant: 'outline' }), 'h-11 w-full')}
        >
          <MapPin />
          Open in Maps
        </a>
      </Section>

      <Section title="Problem">
        <p className="whitespace-pre-wrap">{job.problem}</p>
        <p className="text-muted-foreground">System: {SYSTEM_TYPE_LABELS[job.systemType]}</p>
        {property.equipmentBrand && (
          <p className="text-muted-foreground">
            Equipment: {property.equipmentBrand}
            {property.equipmentYear && `, installed about ${property.equipmentYear}`}
          </p>
        )}
        {job.vulnerableOccupant && (
          <p className="font-medium text-red-700">
            Someone vulnerable is home without heat or cooling.
          </p>
        )}
        {photos.length > 0 && (
          <ul className="flex flex-wrap gap-2 pt-1">
            {photos.map((photo, index) => (
              <li key={photo.id}>
                <a
                  href={photo.url}
                  target="_blank"
                  rel="noreferrer"
                  className="block rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  <img
                    src={photo.url}
                    alt={`Homeowner’s upload ${index + 1}`}
                    className="size-24 rounded-lg object-cover"
                  />
                </a>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Office notes">
        {notes.length === 0 ? (
          <p className="text-muted-foreground">No notes yet.</p>
        ) : (
          <ul className="space-y-2">
            {notes.map((note) => (
              <li key={note.id} className="rounded-lg bg-muted/60 p-2.5">
                <p className="whitespace-pre-wrap">{note.body}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {note.authorName ?? 'AI receptionist'} · {noteTime.format(new Date(note.createdAt))}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  )
}

function Section({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="space-y-1.5 rounded-xl bg-card p-4 text-sm shadow-sm">
      {title && <h3 className="font-medium">{title}</h3>}
      {children}
    </section>
  )
}

function BackLink() {
  return (
    <Link
      to="/jobs"
      className="inline-flex items-center gap-1.5 text-sm font-medium text-primary underline-offset-4 hover:underline"
    >
      <ArrowLeft className="size-4" />
      Back to your jobs
    </Link>
  )
}
```

- [ ] **Step 6: Show it on `/jobs/:jobId`**

Replace `relay-web/src/routes/job.tsx` with:

```tsx
import { useParams } from 'react-router'
import { PageShell } from '@/components/page-shell'
import { SignOutButton } from '@/features/auth/sign-out-button'
import { useMyJobsLiveUpdates } from '@/features/technician-jobs/api'
import { JobDetails } from '@/features/technician-jobs/job-details'

// One of the technician's jobs, opened from their list. Texted job links (module 8, part 3)
// will get their own path.
export function JobPage() {
  const { jobId = '' } = useParams()
  useMyJobsLiveUpdates()

  return (
    <PageShell title="Your job" actions={<SignOutButton to="/sign-in/phone" />}>
      <JobDetails jobId={jobId} />
    </PageShell>
  )
}
```

In `relay-web/src/router.tsx`, change:

```tsx
          { path: '/jobs/:token', element: <JobPage /> },
```

to:

```tsx
          { path: '/jobs/:jobId', element: <JobPage /> },
```

- [ ] **Step 7: Typecheck, test, lint, commit**

```bash
npm run typecheck
npm test
npx biome check --write src/features/technician-jobs/maps.ts src/features/technician-jobs/maps.test.ts src/features/technician-jobs/job-details.tsx src/routes/job.tsx src/router.tsx
git add src/features/technician-jobs src/routes/job.tsx src/router.tsx
git commit -m "feat: add the technician's job page"
```

Expected: typecheck prints nothing; tests pass; Biome reports no errors.

---

### Task 5: Check it in the running app

**Files:** none in the repos (scripts and screenshots go to the session scratchpad).

- [ ] **Step 1: Sign in as Sam Patel at phone width**

With both apps running, open `http://desert.localhost:5173/sign-in/phone` in a 390 px wide window and sign in as Sam Patel `(480) 555-0301` (the code is in the relay-api terminal on the `Development only: the text that would be sent` line).
Expected: `/jobs` shows "Your jobs" and either today's and upcoming jobs or "No jobs assigned to you for the next 7 days."

- [ ] **Step 2: Assign him a job from the office, with the tech page open**

In a second window, sign in as `office@desert.test` (password: `DEV_PASSWORD` in relay-api's `src/db/seed.ts`), open the dispatch board, open a job for today and assign it to Sam Patel.
Expected: within about a second, the job appears on Sam's list without a refresh.

- [ ] **Step 3: Open the job**

Tap the card.
Expected: the job page shows the customer, service, day and window, status, Call and Text buttons, the address with Open in Maps, the problem, system type, any booking photos and the office notes. Call opens `tel:`, Text opens `sms:`, Maps opens a Google Maps search for the address.

- [ ] **Step 4: Reassign it**

From the office window, assign the job to Rita Gomez.
Expected: Sam's job page shows "This job isn’t assigned to you anymore." with Back to your jobs; the list no longer has the job.

- [ ] **Step 5: Report**

Report the screenshots and anything that didn't match.
