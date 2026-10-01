# Technician Status Buttons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A technician changes a job from their job page with On my way, Running late, Start job, No access and Job complete; the board updates live, the homeowner gets a text when they are waiting, and arrival times show to the technician and the office.

**Architecture:** Job status rules live in one place: `dispatch.service.ts` gets an exported `changeStatus()` that both the office route and the technician routes call (the office's `setStatus()` becomes a thin wrapper). The `technician-jobs` module adds the technician-only parts on top: the "is it yours" check, arrival times, the homeowner text (built by pure functions in `texts.ts`) and the No access note. Module dependencies stay one-way: `technician-jobs` → `dispatch`, never the reverse.

**Tech Stack:** relay-api: Express 5, Drizzle ORM, PostgreSQL 18, Zod 4, Vitest + Supertest. relay-web: React 19, TanStack Query, Zod 4, Base UI dialogs (shadcn), sonner toasts, Vitest.

**Spec:** `relay-api/docs/superpowers/specs/2026-10-02-technician-status-buttons-design.md`

## Global Constraints

- Branch `feat/technician-status-buttons` in both repos (already created from `main`; the spec is committed in relay-api).
- Architecture: a rule lives in exactly one place (status transitions only in `dispatch.service.ts`); modules keep routes → service → queries; `technician-jobs` may import `dispatch`, `dispatch` never imports `technician-jobs`; text wording and time formatting are pure functions with their own tests; reuse existing queries before writing new SQL. Balance with lean, plain code a junior developer can debug.
- No object property named `then` (it makes the object a "thenable"); the `changeStatus()` hooks are `checkJob` and `afterChange`.
- Commit messages: lowercase conventional (`feat: …`, `refactor: …`). No `Co-Authored-By` trailer.
- Biome only on touched files: `npx biome check --write <paths>`.
- Minutes: On my way `15, 30, 45, 60`; Running late `15, 30, 45, 60, 90`. Arrival = now + minutes.
- An arrival time shows ("Arriving about …") only while the job is `booked` or `en_route`. Every status change saves the new arrival time or clears it; moving or reassigning a job clears it.
- Times in texts and labels are in the contractor's time zone (`tenants.timezone`) and use `formatTime()`'s style: `9:10 AM`, `12 PM`.
- Exact copy (straight quotes in code are typographic `’` like the rest of the app):
  - On my way text: `<Contractor>: <First name> is on the way and should arrive about <time>.`
  - Running late text: `<Contractor>: <First name> is running late and should now arrive about <time>. Sorry for the wait.`
  - No access text: `<Contractor>: <First name> came by at <time> but couldn’t reach you. We’ll call you to set a new time.`
  - Running late refused: `This job is <status label>, so it can’t be running late.` (status label from `statusLabel()`, e.g. `in progress`)
  - Not yours: `This job isn’t assigned to you anymore.`
  - Bad minutes: `Pick how far away you are`
  - Note too long: `Keep the note under 1,000 characters`
  - Buttons: `On my way`, `Running late`, `Start job`, `No access`, `Job complete`
  - Sheets: `How far away are you?` / `We’ll text the homeowner your arrival time.`; `How far away are you now?` / `We’ll text the homeowner the new time.`; `Couldn’t get in?` / `We’ll text the homeowner and the office will reschedule.` with `Note (optional)` and `Mark no access`; `Mark this visit done?` / `This can’t be undone.` with `Job complete`
  - Status lines: `Arriving about <time>`, `The office will reschedule this visit.`, `Done at <time>.`
  - Network failure toast: `Couldn’t update the job. Check your connection and try again.`
- Small additions beyond the spec, both to keep code simple: list cards also carry `dateLabel` (the Earlier section needs the day), and the office drawer's job also carries `completedLabel` (the job page's query is shared).

## Files

relay-api:
- Modify `src/modules/dispatch/dispatch.queries.ts`: `localOrNull()`, `etaLocal`/`completedLocal` columns, `insertNote()` takes a transaction.
- Modify `src/modules/dispatch/dispatch.service.ts`: `arrivalLabel()`, `changeStatus()`, thin `setStatus()`, `etaLabel` on the board and drawer, `moveJob()` clears the arrival time.
- Modify `src/modules/dispatch/dispatch.test.ts`: arrival-time tests.
- Modify `src/lib/labels.ts`; create `src/lib/labels.test.ts`: `formatClock()`.
- Create `src/modules/technician-jobs/texts.ts` + `texts.test.ts`: the three homeowner texts.
- Modify `src/modules/messaging/sms.ts`: `sendText()` takes `jobId` and `customerId`.
- Create `src/modules/technician-jobs/technician-jobs.schemas.ts`: action inputs.
- Modify `src/modules/technician-jobs/technician-jobs.{queries,service,routes}.ts`: actions, `findJobContact()`, Earlier list, labels.
- Create `src/modules/technician-jobs/job-actions.test.ts`; modify `technician-jobs.test.ts`.

relay-web:
- Modify `src/features/technician-jobs/api.ts`: new fields, `useJobAction()`.
- Create `src/features/technician-jobs/arrival.ts` + `arrival.test.ts`: `arrivalPreview()`.
- Create `src/features/technician-jobs/job-actions.tsx`: buttons and sheets.
- Modify `src/features/technician-jobs/job-details.tsx` and `job-list.tsx`.
- Modify `src/features/dispatch/api.ts`, `job-card.tsx`, `job-drawer.tsx`: `etaLabel`.

---

### Task 1: API — one status change for office and technician, arrival times on the board

**Files:**
- Modify: `relay-api/src/modules/dispatch/dispatch.queries.ts` (after `local()`; `listJobsOn` select; `findJobDetail` select; `insertNote`)
- Modify: `relay-api/src/modules/dispatch/dispatch.service.ts` (imports; new functions; `getBoard`; `getJob`; `moveJob` update; `setStatus`)
- Test: `relay-api/src/modules/dispatch/dispatch.test.ts`

**Interfaces:**
- Consumes: `formatTime` from `src/lib/labels.ts`; `type Tx` from `src/db/client.ts`.
- Produces:
  - `localOrNull(column: PgColumn, format: string): SQL<string | null>` (dispatch.queries)
  - `findJobDetail` rows gain `etaLocal: string | null`, `completedLocal: string | null`; `listJobsOn` rows gain `etaLocal`
  - `insertNote(tenantId, values, tx?: Db)`
  - `arrivalLabel(status: JobStatus, etaLocal: string | null): string | null` (dispatch.service)
  - `changeStatus(change: { tenantId: string; actorUserId: string; jobId: string; to: JobStatus; etaAt?: Date; checkJob?: (job: LockedJob) => void; afterChange?: (tx: Tx) => Promise<void> }): Promise<{ changed: boolean; date: string }>` where `LockedJob` = the row `queries.lockJob()` returns (`{ id, status, technicianId, date, windowId }`)
  - Board jobs and the drawer's `job` gain `etaLabel: string | null`; the drawer's `job` gains `completedLabel: string | null`

- [ ] **Step 1: Write the failing tests**

In `relay-api/src/modules/dispatch/dispatch.test.ts`, append:

```ts
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
```

- [ ] **Step 2: Run them to verify they fail**

Run (in `relay-api`): `npx vitest run src/modules/dispatch/dispatch.test.ts`
Expected: the 2 new tests FAIL (`etaLabel` is `undefined`; `etaAt` is not cleared). Every other dispatch test PASSES.

- [ ] **Step 3: Add the query columns**

In `relay-api/src/modules/dispatch/dispatch.queries.ts`, add after `local()`:

```ts
// Like local(), for a column that may be empty: null stays null.
export function localOrNull(column: PgColumn, format: string): SQL<string | null> {
  return sql<string | null>`to_char(${column} at time zone ${tenants.timezone}, ${format})`
}
```

In `listJobsOn`'s select, after `localEnd: …`, add:

```ts
      etaLocal: localOrNull(jobs.etaAt, 'HH24:MI:SS'), // set by "On my way" / "Running late"
```

In `findJobDetail`'s select, after `localEnd: …`, add:

```ts
      etaLocal: localOrNull(jobs.etaAt, 'HH24:MI:SS'),
      completedLocal: localOrNull(jobs.completedAt, 'HH24:MI:SS'),
```

Replace `insertNote` with a version that can join a transaction:

```ts
export async function insertNote(
  tenantId: string,
  values: { jobId: string; authorId: string; body: string },
  tx: Db = db,
) {
  const [note] = await tx
    .insert(jobNotes)
    .values({ ...values, tenantId })
    .returning({ id: jobNotes.id, body: jobNotes.body, createdAt: jobNotes.createdAt })
  return note
}
```

- [ ] **Step 4: Add `arrivalLabel()` and `changeStatus()`, and make `setStatus()` use it**

In `relay-api/src/modules/dispatch/dispatch.service.ts`:

Change the first import to `import { db, type Tx } from '../../db/client.ts'` and the labels import to:

```ts
import { formatDay, formatTime, formatWindow, statusLabel, weekdayOf } from '../../lib/labels.ts'
```

Add after the `JOB_NOT_FOUND` constant:

```ts
type LockedJob = NonNullable<Awaited<ReturnType<typeof queries.lockJob>>>

// "Arriving about 9:10 AM": only while the visit hasn't started, and only once the technician
// gave a time with "On my way" or "Running late".
export function arrivalLabel(status: JobStatus, etaLocal: string | null): string | null {
  return etaLocal && (status === 'booked' || status === 'en_route') ? formatTime(etaLocal) : null
}
```

Replace the whole `setStatus` function with:

```ts
// One status change, for the office's drawer and the technician's buttons alike: the only
// place the status rules are applied. `checkJob` runs on the locked job before the rules (the
// technician side checks the job is still theirs). `afterChange` runs in the same transaction,
// only when the status really changed (a homeowner text, a note).
export async function changeStatus(change: {
  tenantId: string
  actorUserId: string
  jobId: string
  to: JobStatus
  etaAt?: Date
  checkJob?: (job: LockedJob) => void
  afterChange?: (tx: Tx) => Promise<void>
}) {
  const { tenantId, jobId, to } = change
  const result = await db.transaction(async (tx) => {
    const job = await queries.lockJob(tenantId, jobId, tx)
    if (!job) throw new HttpError(404, 'not_found', JOB_NOT_FOUND)
    change.checkJob?.(job)
    // A double click, or someone else got there first: nothing to do.
    if (job.status === to) return { changed: false, date: job.date }

    const from = statusLabel(job.status)
    if (FINAL.includes(job.status)) {
      throw new HttpError(
        422,
        'invalid_transition',
        `This job is already ${from}, so its status can’t change.`,
      )
    }
    if (!(TRANSITIONS[job.status] ?? []).includes(to)) {
      const hint = to === 'done' ? ' Mark it in progress first.' : ''
      throw new HttpError(
        422,
        'invalid_transition',
        `This job is ${from}, so it can’t be marked ${statusLabel(to)}.${hint}`,
      )
    }
    if (NEEDS_TECHNICIAN.includes(to) && !job.technicianId) {
      throw new HttpError(
        422,
        'technician_required',
        `Assign a technician before marking this job ${statusLabel(to)}.`,
      )
    }

    const closing = to === 'done' || to === 'cancelled'
    await queries.updateJob(
      tenantId,
      job.id,
      {
        status: to,
        // An arrival time belongs to the step it was given for; any other change clears it.
        etaAt: change.etaAt ?? null,
        ...(to === 'done' ? { completedAt: new Date() } : {}),
        // Job links stop working once a job is closed.
        ...(closing ? { techLinkHash: null, manageLinkHash: null } : {}),
      },
      tx,
    )
    await audit.insertUserAction(
      tenantId,
      {
        actorUserId: change.actorUserId,
        action: 'job.status_changed',
        entityType: 'job',
        entityId: job.id,
        data: { from: job.status, to },
      },
      tx,
    )
    await change.afterChange?.(tx)
    return { changed: true, date: job.date }
  })

  if (result.changed) {
    emitToTenant(tenantId, 'job.status_changed', { jobId, dates: [result.date] })
  }
  return result
}

// The office sets a job's status by hand from the drawer.
export async function setStatus(user: SessionUser, jobId: string, to: SettableStatus) {
  const { date } = await changeStatus({
    tenantId: tenantOf(user),
    actorUserId: user.id,
    jobId,
    to,
  })
  return { jobId, dates: [date] }
}
```

- [ ] **Step 5: Show arrival times on the board and in the drawer**

In `getBoard`, replace the `jobs:` mapping with:

```ts
    jobs: jobRows.map(({ localStart, localEnd, etaLocal, ...job }) => ({
      ...job,
      windowLabel: formatWindow(localStart, localEnd),
      etaLabel: arrivalLabel(job.status, etaLocal),
    })),
```

In `getJob`, replace the destructuring line and the `job:` object with:

```ts
  const {
    localStart,
    localEnd,
    etaLocal,
    completedLocal,
    technicianId,
    technicianName,
    ...rest
  } = job
  return {
    job: {
      ...rest,
      dateLabel: formatDay(job.date),
      windowLabel: formatWindow(localStart, localEnd),
      etaLabel: arrivalLabel(job.status, etaLocal),
      completedLabel: completedLocal ? formatTime(completedLocal) : null,
      technician: technicianId ? { id: technicianId, name: technicianName } : null,
      allowedStatuses: TRANSITIONS[job.status] ?? [],
    },
```

(the `notes` and `photos` lines that follow stay as they are).

In `moveJob`, in the `queries.updateJob(...)` values, add after `...slot,`:

```ts
        // A new time or technician makes the old arrival time meaningless.
        etaAt: null,
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run src/modules/dispatch/dispatch.test.ts`
Expected: PASS, including the 2 new tests and every existing status test (office behaviour unchanged).

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Typecheck, lint, commit**

```bash
npm run typecheck
npx biome check --write src/modules/dispatch/dispatch.queries.ts src/modules/dispatch/dispatch.service.ts src/modules/dispatch/dispatch.test.ts
git add src/modules/dispatch
git commit -m "refactor: share one job status change and show arrival times on the board"
```

---

### Task 2: API — homeowner texts and clock times as pure functions

**Files:**
- Modify: `relay-api/src/lib/labels.ts` (after `formatTime`)
- Create: `relay-api/src/lib/labels.test.ts`
- Create: `relay-api/src/modules/technician-jobs/texts.ts`
- Create: `relay-api/src/modules/technician-jobs/texts.test.ts`
- Modify: `relay-api/src/modules/messaging/sms.ts` (`sendText`'s `text` parameter)

**Interfaces:**
- Produces:
  - `formatClock(at: Date, timezone: string): string` (`'9:10 AM'`, `'12 PM'`)
  - `onMyWayText(who: Who, arrival: string)`, `runningLateText(who: Who, arrival: string)`, `noAccessText(who: Who, cameAt: string)`, all `string`, where `Who = { contractorName: string; technicianName: string }`
  - `sendText(tenantId, text: { contact; kind; body; toUserId?; jobId?: string; customerId?: string }, tx?)`

- [ ] **Step 1: Write the failing tests**

Create `relay-api/src/lib/labels.test.ts`:

```ts
import { expect, it } from 'vitest'
import { formatClock } from './labels.ts'

it('shows a moment as the contractor’s wall clock', () => {
  expect(formatClock(new Date('2030-01-08T16:10:00Z'), 'America/Phoenix')).toBe('9:10 AM')
  expect(formatClock(new Date('2030-01-08T19:00:00Z'), 'America/Phoenix')).toBe('12 PM')
  // Daylight saving time: Los Angeles is UTC-7 in July.
  expect(formatClock(new Date('2030-07-08T16:10:00Z'), 'America/Los_Angeles')).toBe('9:10 AM')
})
```

Create `relay-api/src/modules/technician-jobs/texts.test.ts`:

```ts
import { expect, it } from 'vitest'
import { noAccessText, onMyWayText, runningLateText } from './texts.ts'

const who = { contractorName: 'Desert Breeze Air', technicianName: 'Sam Patel' }

it('says the technician is on the way, with their first name only', () => {
  expect(onMyWayText(who, '9:10 AM')).toBe(
    'Desert Breeze Air: Sam is on the way and should arrive about 9:10 AM.',
  )
})

it('gives the new arrival time when running late', () => {
  expect(runningLateText(who, '11:15 AM')).toBe(
    'Desert Breeze Air: Sam is running late and should now arrive about 11:15 AM. Sorry for the wait.',
  )
})

it('says when the technician came by and that the office will call', () => {
  expect(noAccessText(who, '1:30 PM')).toBe(
    'Desert Breeze Air: Sam came by at 1:30 PM but couldn’t reach you. We’ll call you to set a new time.',
  )
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/lib/labels.test.ts src/modules/technician-jobs/texts.test.ts`
Expected: FAIL. `formatClock` is not exported; `./texts.ts` can't be found.

- [ ] **Step 3: Add `formatClock()`**

In `relay-api/src/lib/labels.ts`, add after `formatTime`:

```ts
// A moment as the contractor's wall clock, '9:10 AM' or '12 PM', for times worked out in code
// (an arrival time) rather than read from the database already in local time.
export function formatClock(at: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at)
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '00'
  return formatTime(`${part('hour')}:${part('minute')}:00`)
}
```

- [ ] **Step 4: Add the texts**

Create `relay-api/src/modules/technician-jobs/texts.ts`:

```ts
// The texts a homeowner gets when their technician taps a button: short, signed with the
// contractor's name, and only the technician's first name.

type Who = { contractorName: string; technicianName: string }

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0]
}

export function onMyWayText(who: Who, arrival: string): string {
  return `${who.contractorName}: ${firstName(who.technicianName)} is on the way and should arrive about ${arrival}.`
}

export function runningLateText(who: Who, arrival: string): string {
  return `${who.contractorName}: ${firstName(who.technicianName)} is running late and should now arrive about ${arrival}. Sorry for the wait.`
}

export function noAccessText(who: Who, cameAt: string): string {
  return `${who.contractorName}: ${firstName(who.technicianName)} came by at ${cameAt} but couldn’t reach you. We’ll call you to set a new time.`
}
```

- [ ] **Step 5: Let `sendText()` link a text to its job and customer**

In `relay-api/src/modules/messaging/sms.ts`, change the `text` parameter's type to:

```ts
  text: {
    contact: string
    kind: (typeof MESSAGE_KINDS)[number]
    body: string
    toUserId?: string // the staff member or technician it goes to
    jobId?: string // the job it is about
    customerId?: string // the homeowner it goes to
  },
```

(the insert already spreads `...text` into the row, and `messages` has `job_id` and `customer_id`).

- [ ] **Step 6: Run the tests**

Run: `npx vitest run src/lib/labels.test.ts src/modules/technician-jobs/texts.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 7: Typecheck, lint, commit**

```bash
npm run typecheck
npx biome check --write src/lib/labels.ts src/lib/labels.test.ts src/modules/technician-jobs/texts.ts src/modules/technician-jobs/texts.test.ts src/modules/messaging/sms.ts
git add src/lib/labels.ts src/lib/labels.test.ts src/modules/technician-jobs/texts.ts src/modules/technician-jobs/texts.test.ts src/modules/messaging/sms.ts
git commit -m "feat: add the homeowner texts for technician updates"
```

---

### Task 3: API — the five technician actions

**Files:**
- Create: `relay-api/src/modules/technician-jobs/technician-jobs.schemas.ts`
- Modify: `relay-api/src/modules/technician-jobs/technician-jobs.queries.ts` (imports; new `findJobContact`)
- Modify: `relay-api/src/modules/technician-jobs/technician-jobs.service.ts`
- Modify: `relay-api/src/modules/technician-jobs/technician-jobs.routes.ts`
- Test: `relay-api/src/modules/technician-jobs/job-actions.test.ts`

**Interfaces:**
- Consumes: `changeStatus`, `arrivalLabel` (Task 1); `dispatch.queries` `lockJob`, `updateJob`, `insertNote`, `findJobDetail` (with `etaLocal`, `completedLocal`); `formatClock`, `formatTime`, `statusLabel` (labels); texts (Task 2); `sendText` (Task 2); `emitToTenant`; `audit.insertUserAction`.
- Produces:
  - Routes `POST /api/my-jobs/:jobId/{on-my-way,running-late,start,no-access,complete}`, each answering with `getMyJob()`'s shape
  - `getMyJob()`'s `job` gains `etaLabel: string | null` and `completedLabel: string | null`
  - Service: `onMyWay(user, jobId, minutes)`, `runningLate(user, jobId, minutes)`, `startJob(user, jobId)`, `noAccess(user, jobId, note)`, `completeJob(user, jobId)`
  - Queries: `findJobContact(tenantId, jobId, tx)` → `{ contractorName, timezone, customerId, customerPhone: string | null, technicianName }`, `type JobContact`

- [ ] **Step 1: Write the failing tests**

Create `relay-api/src/modules/technician-jobs/job-actions.test.ts`:

```ts
import { eq } from 'drizzle-orm'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createJob, createShop, resetDb, signInTechnician } from '../../../test/helpers.ts'
import { createApp } from '../../app.ts'
import { db } from '../../db/client.ts'
import { auditEvents, customers, jobNotes, jobs, messages } from '../../db/schema.ts'
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
      expect.objectContaining({ jobId: job.id, authorId: shop.mike.id, body: 'Gate locked, called twice' }),
    ])
    expect(res.body.notes).toEqual([
      expect.objectContaining({ body: 'Gate locked, called twice', authorName: 'Mike' }),
    ])
    const [text] = await db.select().from(messages)
    expect(text.kind).toBe('no_access')
    expect(text.body).toMatch(
      /^desert HVAC: Mike came by at \d{1,2}(:\d{2})? (AM|PM) but couldn’t reach you\. We’ll call you to set a new time\.$/,
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
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/modules/technician-jobs/job-actions.test.ts`
Expected: FAIL. Every test gets `404` (no action routes yet) where `200`, `400`, `403` or `422` is expected.

- [ ] **Step 3: Add the input schemas**

Create `relay-api/src/modules/technician-jobs/technician-jobs.schemas.ts`:

```ts
import { z } from 'zod'

// How far away the technician is, in minutes. Running late adds a longer choice.
const ARRIVAL_MINUTES = [15, 30, 45, 60]
const LATE_MINUTES = [...ARRIVAL_MINUTES, 90]

export const OnMyWayInput = z.object({
  minutes: z.literal(ARRIVAL_MINUTES, 'Pick how far away you are'),
})

export const RunningLateInput = z.object({
  minutes: z.literal(LATE_MINUTES, 'Pick how far away you are'),
})

export const NoAccessInput = z.object({
  note: z.string().trim().max(1000, 'Keep the note under 1,000 characters').default(''),
})
```

- [ ] **Step 4: Add the contact query**

In `relay-api/src/modules/technician-jobs/technician-jobs.queries.ts`, change the imports to:

```ts
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { type Db, db } from '../../db/client.ts'
import { customers, jobs, properties, services, tenants, users } from '../../db/schema.ts'
import { local } from '../dispatch/dispatch.queries.ts'
```

and append:

```ts
// Who to text about a job and how to sign it: the homeowner's phone, the contractor's name and
// time zone, the technician's name. Read inside the transaction that changes the job.
export async function findJobContact(tenantId: string, jobId: string, tx: Db) {
  const [contact] = await tx
    .select({
      contractorName: tenants.name,
      timezone: tenants.timezone,
      customerId: customers.id,
      customerPhone: customers.phone,
      technicianName: users.name,
    })
    .from(jobs)
    .innerJoin(tenants, eq(tenants.id, jobs.tenantId))
    .innerJoin(customers, eq(customers.id, jobs.customerId))
    .innerJoin(users, eq(users.id, jobs.technicianId))
    .where(and(eq(jobs.tenantId, tenantId), eq(jobs.id, jobId)))
  return contact
}
export type JobContact = Awaited<ReturnType<typeof findJobContact>>
```

- [ ] **Step 5: Add the actions to the service**

In `relay-api/src/modules/technician-jobs/technician-jobs.service.ts`, replace the imports with:

```ts
import { db, type Tx } from '../../db/client.ts'
import { HttpError } from '../../lib/http-error.ts'
import { formatClock, formatDay, formatTime, formatWindow, statusLabel } from '../../lib/labels.ts'
import { emitToTenant } from '../../realtime/index.ts'
import type { SessionUser } from '../accounts/accounts.service.ts'
import * as audit from '../audit/audit.queries.ts'
import { tenantOf } from '../booking/booking.service.ts'
import * as dispatchQueries from '../dispatch/dispatch.queries.ts'
import { arrivalLabel, changeStatus } from '../dispatch/dispatch.service.ts'
import { sendText } from '../messaging/sms.ts'
import * as queries from './technician-jobs.queries.ts'
import { noAccessText, onMyWayText, runningLateText } from './texts.ts'
```

Rename the remaining uses of `dispatch.` in this file to `dispatchQueries.` (`findJobDetail`, `listNotes`, `listJobPhotos`, `findJobPhoto`).

Replace the `findMyJob` function with:

```ts
function notYours() {
  return new HttpError(404, 'not_found', NOT_YOURS)
}

// The job, if it's this technician's and still shows on their list. Anything else (another
// technician's, unassigned, another contractor's, cancelled) gets the same 404, so the answer
// doesn't reveal which jobs exist.
async function findMyJob(user: SessionUser, jobId: string) {
  const job = await dispatchQueries.findJobDetail(tenantOf(user), jobId)
  const visible = (queries.VISIBLE_STATUSES as readonly string[]).includes(job?.status ?? '')
  if (!job || job.technicianId !== user.id || !visible) throw notYours()
  return job
}
```

In `getMyJob`'s `job:` object, add after `windowLabel: …`:

```ts
      etaLabel: arrivalLabel(job.status, job.etaLocal),
      completedLabel: job.completedLocal ? formatTime(job.completedLocal) : null,
```

Append:

```ts
// An arrival time `minutes` from now.
function arrivalIn(minutes: number): Date {
  return new Date(Date.now() + minutes * 60 * 1000)
}

// Saves a text to the job's homeowner in the caller's transaction, so the change and the text
// are saved together or not at all. A homeowner without a phone gets none; the change stands.
async function textHomeowner(
  tenantId: string,
  jobId: string,
  kind: 'on_my_way' | 'running_late' | 'no_access',
  body: (contact: queries.JobContact) => string,
  tx: Tx,
) {
  const contact = await queries.findJobContact(tenantId, jobId, tx)
  if (!contact.customerPhone) return
  await sendText(
    tenantId,
    {
      contact: contact.customerPhone,
      kind,
      body: body(contact),
      jobId,
      customerId: contact.customerId,
    },
    tx,
  )
}

// A technician's status button: checks the job is theirs, then changes it through dispatch,
// where the status rules live. Answers with the refreshed job page.
async function changeMyJob(
  user: SessionUser,
  jobId: string,
  to: 'en_route' | 'in_progress' | 'no_access' | 'done',
  extras: { etaAt?: Date; afterChange?: (tx: Tx) => Promise<void> } = {},
) {
  await findMyJob(user, jobId)
  await changeStatus({
    tenantId: tenantOf(user),
    actorUserId: user.id,
    jobId,
    to,
    ...extras,
    // The office may have reassigned the job since the check above.
    checkJob: (job) => {
      if (job.technicianId !== user.id) throw notYours()
    },
  })
  return getMyJob(user, jobId)
}

export function onMyWay(user: SessionUser, jobId: string, minutes: number) {
  const etaAt = arrivalIn(minutes)
  return changeMyJob(user, jobId, 'en_route', {
    etaAt,
    afterChange: (tx) =>
      textHomeowner(
        tenantOf(user),
        jobId,
        'on_my_way',
        (contact) => onMyWayText(contact, formatClock(etaAt, contact.timezone)),
        tx,
      ),
  })
}

export function startJob(user: SessionUser, jobId: string) {
  return changeMyJob(user, jobId, 'in_progress')
}

// No access: the optional note goes on the job under the technician's name, and the
// homeowner hears that the office will call.
export function noAccess(user: SessionUser, jobId: string, note: string) {
  const tenantId = tenantOf(user)
  return changeMyJob(user, jobId, 'no_access', {
    afterChange: async (tx) => {
      if (note) {
        await dispatchQueries.insertNote(tenantId, { jobId, authorId: user.id, body: note }, tx)
      }
      await textHomeowner(
        tenantId,
        jobId,
        'no_access',
        (contact) => noAccessText(contact, formatClock(new Date(), contact.timezone)),
        tx,
      )
    },
  })
}

export function completeJob(user: SessionUser, jobId: string) {
  return changeMyJob(user, jobId, 'done')
}

// Running late moves the arrival time, not the status, so it doesn't go through
// changeStatus(). It still locks the job, so it can't race the office.
export async function runningLate(user: SessionUser, jobId: string, minutes: number) {
  await findMyJob(user, jobId)
  const tenantId = tenantOf(user)
  const etaAt = arrivalIn(minutes)
  const date = await db.transaction(async (tx) => {
    const job = await dispatchQueries.lockJob(tenantId, jobId, tx)
    if (!job || job.technicianId !== user.id) throw notYours()
    if (job.status !== 'booked' && job.status !== 'en_route') {
      throw new HttpError(
        422,
        'invalid_transition',
        `This job is ${statusLabel(job.status)}, so it can’t be running late.`,
      )
    }
    await dispatchQueries.updateJob(tenantId, jobId, { etaAt }, tx)
    await audit.insertUserAction(
      tenantId,
      {
        actorUserId: user.id,
        action: 'job.eta_changed',
        entityType: 'job',
        entityId: jobId,
        data: { etaAt: etaAt.toISOString(), minutes },
      },
      tx,
    )
    await textHomeowner(
      tenantId,
      jobId,
      'running_late',
      (contact) => runningLateText(contact, formatClock(etaAt, contact.timezone)),
      tx,
    )
    return job.date
  })
  // The board and the technician's pages reload on this event and show the new time.
  emitToTenant(tenantId, 'job.status_changed', { jobId, dates: [date] })
  return getMyJob(user, jobId)
}
```

- [ ] **Step 6: Add the routes**

In `relay-api/src/modules/technician-jobs/technician-jobs.routes.ts`, add to the imports:

```ts
import { NoAccessInput, OnMyWayInput, RunningLateInput } from './technician-jobs.schemas.ts'
```

and append:

```ts
technicianJobsRoutes.post('/my-jobs/:jobId/on-my-way', technician, async (req, res) => {
  const { jobId } = JobParams.parse(req.params)
  const { minutes } = OnMyWayInput.parse(req.body)
  res.json(await technicianJobs.onMyWay(req.user!, jobId, minutes))
})

technicianJobsRoutes.post('/my-jobs/:jobId/running-late', technician, async (req, res) => {
  const { jobId } = JobParams.parse(req.params)
  const { minutes } = RunningLateInput.parse(req.body)
  res.json(await technicianJobs.runningLate(req.user!, jobId, minutes))
})

technicianJobsRoutes.post('/my-jobs/:jobId/start', technician, async (req, res) => {
  const { jobId } = JobParams.parse(req.params)
  res.json(await technicianJobs.startJob(req.user!, jobId))
})

technicianJobsRoutes.post('/my-jobs/:jobId/no-access', technician, async (req, res) => {
  const { jobId } = JobParams.parse(req.params)
  const { note } = NoAccessInput.parse(req.body)
  res.json(await technicianJobs.noAccess(req.user!, jobId, note))
})

technicianJobsRoutes.post('/my-jobs/:jobId/complete', technician, async (req, res) => {
  const { jobId } = JobParams.parse(req.params)
  res.json(await technicianJobs.completeJob(req.user!, jobId))
})
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run src/modules/technician-jobs`
Expected: PASS (the new `job-actions.test.ts` and the existing `technician-jobs.test.ts`).

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Typecheck, lint, commit**

```bash
npm run typecheck
npx biome check --write src/modules/technician-jobs/technician-jobs.schemas.ts src/modules/technician-jobs/technician-jobs.queries.ts src/modules/technician-jobs/technician-jobs.service.ts src/modules/technician-jobs/technician-jobs.routes.ts src/modules/technician-jobs/job-actions.test.ts
git add src/modules/technician-jobs
git commit -m "feat: let technicians update a job from their job page"
```

---

### Task 4: API — the Earlier section and arrival times on the list

**Files:**
- Modify: `relay-api/src/modules/technician-jobs/technician-jobs.queries.ts` (`listTechnicianJobs`)
- Modify: `relay-api/src/modules/technician-jobs/technician-jobs.service.ts` (`listMyJobs`)
- Test: `relay-api/src/modules/technician-jobs/technician-jobs.test.ts`

**Interfaces:**
- Consumes: `localOrNull` (Task 1), `arrivalLabel` (Task 1).
- Produces: `GET /api/my-jobs` → `{ earlier: Card[], days: { date, label, jobs: Card[] }[] }` with `Card = { id, status, priority, dateLabel, windowLabel, etaLabel, customerName, street, city, serviceName }`; queries `listEarlierTechnicianJobs(tenantId, technicianId)`.

- [ ] **Step 1: Update and add the tests**

In `relay-api/src/modules/technician-jobs/technician-jobs.test.ts`:

In `'lists this technician's jobs for today and the next 6 days, by day'`, change the expected card to:

```ts
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
```

In `'is empty when nothing is assigned'`, change the expectation to:

```ts
    expect(res.body).toEqual({ earlier: [], days: [] })
```

Add inside `describe('GET /api/my-jobs', …)`:

```ts
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
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/modules/technician-jobs/technician-jobs.test.ts`
Expected: FAIL. The cards have no `dateLabel` or `etaLabel`, and the answer has no `earlier`.

- [ ] **Step 3: Share the card columns and add the Earlier query**

In `relay-api/src/modules/technician-jobs/technician-jobs.queries.ts`, change the dispatch import to:

```ts
import { local, localOrNull } from '../dispatch/dispatch.queries.ts'
```

Replace `listTechnicianJobs` with:

```ts
// The contractor's local today, in SQL. Needs `tenants` joined.
const today = sql`(now() at time zone ${tenants.timezone})::date`

// A job card's columns, joined and ready for a where clause.
function selectCards() {
  return db
    .select({
      id: jobs.id,
      status: jobs.status,
      priority: jobs.priority,
      date: local(jobs.windowStartsAt, 'YYYY-MM-DD'),
      localStart: local(jobs.windowStartsAt, 'HH24:MI:SS'),
      localEnd: local(jobs.windowEndsAt, 'HH24:MI:SS'),
      etaLocal: localOrNull(jobs.etaAt, 'HH24:MI:SS'),
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
}

// A technician's jobs from the start of the contractor's local today, for `days` days, in the
// order the list shows them: by day, done last, then by window, PRIORITY first, oldest first.
export function listTechnicianJobs(tenantId: string, technicianId: string, days: number) {
  return selectCards()
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

// Unfinished visits from before today, oldest first, so a technician can finish yesterday's
// job. No access jobs are left out: rescheduling them is the office's job.
export function listEarlierTechnicianJobs(tenantId: string, technicianId: string) {
  return selectCards()
    .where(
      and(
        eq(jobs.tenantId, tenantId),
        eq(jobs.technicianId, technicianId),
        inArray(jobs.status, ['booked', 'en_route', 'in_progress']),
        sql`${jobs.windowStartsAt} < ${today}::timestamp at time zone ${tenants.timezone}`,
      ),
    )
    .orderBy(asc(jobs.windowStartsAt))
}
```

- [ ] **Step 4: Build cards in one place**

In `relay-api/src/modules/technician-jobs/technician-jobs.service.ts`, replace `listMyJobs` with:

```ts
type CardRow = Awaited<ReturnType<typeof queries.listTechnicianJobs>>[number]

// A job card as the list shows it.
function toCard({ date, localStart, localEnd, etaLocal, ...job }: CardRow) {
  return {
    ...job,
    dateLabel: formatDay(date),
    windowLabel: formatWindow(localStart, localEnd),
    etaLabel: arrivalLabel(job.status, etaLocal),
  }
}

// Unfinished jobs from earlier days, then the technician's jobs grouped by local day. Days
// without jobs are left out.
export async function listMyJobs(user: SessionUser) {
  const tenantId = tenantOf(user)
  const [earlier, rows] = await Promise.all([
    queries.listEarlierTechnicianJobs(tenantId, user.id),
    queries.listTechnicianJobs(tenantId, user.id, DAYS_SHOWN),
  ])
  const days: { date: string; label: string; jobs: ReturnType<typeof toCard>[] }[] = []
  for (const row of rows) {
    // Rows come sorted by day, so a new date always starts a new group.
    if (days.at(-1)?.date !== row.date) {
      days.push({ date: row.date, label: formatDay(row.date), jobs: [] })
    }
    days.at(-1)!.jobs.push(toCard(row))
  }
  return { earlier: earlier.map(toCard), days }
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/modules/technician-jobs`
Expected: PASS.

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
npm run typecheck
npx biome check --write src/modules/technician-jobs/technician-jobs.queries.ts src/modules/technician-jobs/technician-jobs.service.ts src/modules/technician-jobs/technician-jobs.test.ts
git add src/modules/technician-jobs
git commit -m "feat: show earlier unfinished jobs and arrival times on the technician's list"
```

---

### Task 5: Web — the buttons on the job page

**Files:**
- Modify: `relay-web/src/features/technician-jobs/api.ts`
- Create: `relay-web/src/features/technician-jobs/arrival.ts`
- Test: `relay-web/src/features/technician-jobs/arrival.test.ts`
- Create: `relay-web/src/features/technician-jobs/job-actions.tsx`
- Modify: `relay-web/src/features/technician-jobs/job-details.tsx`

**Interfaces:**
- Consumes: the five action routes and the new fields (Tasks 3–4); `Dialog*` from `@/components/ui/dialog`; `Button`; `Textarea`; `toast` from `sonner`; `NetworkError` from `@/lib/api`; `errorMessage`.
- Produces: `arrivalPreview(now: Date, minutes: number, timeZone?: string): string`; `type JobAction`; `useJobAction(jobId)`; `JobActions({ job })`; `MyJobs` cards with `dateLabel`, `etaLabel`, and `earlier`; `MyJob['job']` with `etaLabel`, `completedLabel`.

- [ ] **Step 1: Write the failing preview test**

Create `relay-web/src/features/technician-jobs/arrival.test.ts`:

```ts
import { expect, it } from 'vitest'
import { arrivalPreview } from './arrival'

// 9:00 AM in Phoenix.
const nine = new Date('2030-01-08T16:00:00Z')

it('shows the minutes and the clock time they mean', () => {
  expect(arrivalPreview(nine, 15, 'America/Phoenix')).toBe('15 min · 9:15 AM')
  expect(arrivalPreview(nine, 60, 'America/Phoenix')).toBe('60 min · 10:00 AM')
  expect(arrivalPreview(nine, 180, 'America/Phoenix')).toBe('180 min · 12:00 PM')
})
```

- [ ] **Step 2: Run it to verify it fails**

Run (in `relay-web`): `npx vitest run src/features/technician-jobs/arrival.test.ts`
Expected: FAIL, `Cannot find module './arrival'`.

- [ ] **Step 3: Write the preview**

Create `relay-web/src/features/technician-jobs/arrival.ts`:

```ts
// "15 min · 9:15 AM": how far away, and the clock time that means. In the phone's own time
// zone; tests pass one in.
export function arrivalPreview(now: Date, minutes: number, timeZone?: string): string {
  const at = new Date(now.getTime() + minutes * 60 * 1000)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hourCycle: 'h12',
  }).formatToParts(at)
  const part = (type: string) => parts.find((p) => p.type === type)?.value
  return `${minutes} min · ${part('hour')}:${part('minute')} ${part('dayPeriod')}`
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/features/technician-jobs/arrival.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the new fields and the action hook**

In `relay-web/src/features/technician-jobs/api.ts`:

Change the imports to:

```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
```

Replace `const MyJobs = z.object({ … })` with:

```ts
const MyJobCard = z.object({
  id: z.string(),
  status: z.enum(JOB_STATUSES),
  priority: z.boolean(),
  dateLabel: z.string(), // 'Tue, Jan 8'
  windowLabel: z.string(), // '8 AM–12 PM'
  etaLabel: z.string().nullable(), // '9:10 AM' once the technician gave a time
  customerName: z.string(),
  street: z.string(),
  city: z.string(),
  serviceName: z.string(),
})
export type MyJobCard = z.infer<typeof MyJobCard>

const MyJobs = z.object({
  earlier: z.array(MyJobCard), // unfinished visits from before today
  days: z.array(
    z.object({
      date: z.string(), // '2030-01-08'
      label: z.string(), // 'Tue, Jan 8'
      jobs: z.array(MyJobCard),
    }),
  ),
})
```

In `MyJob`'s `job` object, add after `windowLabel: z.string(),`:

```ts
    etaLabel: z.string().nullable(), // '9:10 AM' while booked or en route
    completedLabel: z.string().nullable(), // '11:42 AM' once done
```

Append:

```ts
// What a technician's button sends. Each answers with the refreshed job page.
export type JobAction =
  | { action: 'on-my-way'; minutes: number }
  | { action: 'running-late'; minutes: number }
  | { action: 'start' }
  | { action: 'no-access'; note: string }
  | { action: 'complete' }

export function useJobAction(jobId: string) {
  const queryClient = useQueryClient()
  const jobKey = [...myJobsKey, 'job', jobId]
  return useMutation({
    mutationFn: ({ action, ...body }: JobAction) =>
      api.post(`/my-jobs/${jobId}/${action}`, body, MyJob),
    onSuccess: (detail) => {
      queryClient.setQueryData(jobKey, detail)
      return queryClient.invalidateQueries({ queryKey: [...myJobsKey, 'list'] })
    },
    // The job changed under the technician (reassigned, cancelled, moved on): show it as it is.
    onError: () => queryClient.invalidateQueries({ queryKey: jobKey }),
  })
}
```

- [ ] **Step 6: Add the buttons and sheets**

Create `relay-web/src/features/technician-jobs/job-actions.tsx`:

```tsx
import { cn } from 'cn'
import { Loader2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { NetworkError } from '@/lib/api'
import { errorMessage } from '@/lib/errors'
import { type JobAction, type MyJob, useJobAction } from './api'
import { arrivalPreview } from './arrival'

type ActionName = JobAction['action']

const LABELS: Record<ActionName, string> = {
  'on-my-way': 'On my way',
  'running-late': 'Running late',
  start: 'Start job',
  'no-access': 'No access',
  complete: 'Job complete',
}

// The buttons each status shows, the main one first. The API applies the same status rules
// as the office's drawer; this only hides moves it would refuse.
const BUTTONS: Partial<Record<MyJob['job']['status'], ActionName[]>> = {
  booked: ['on-my-way', 'running-late', 'start', 'no-access'],
  en_route: ['start', 'running-late', 'no-access'],
  in_progress: ['complete'],
}

const ARRIVAL_MINUTES = [15, 30, 45, 60]
const LATE_MINUTES = [...ARRIVAL_MINUTES, 90]

// The technician's buttons for one job. Start job goes straight through; the others open a
// sheet first (how far away, a no-access note, or a confirm).
export function JobActions({ job }: { job: MyJob['job'] }) {
  const [sheet, setSheet] = useState<ActionName | null>(null)
  const [note, setNote] = useState('')
  const action = useJobAction(job.id)
  const busy = action.isPending

  function run(change: JobAction) {
    action.mutate(change, {
      onSuccess: () => {
        setSheet(null)
        setNote('')
      },
      onError: (error) => {
        setSheet(null)
        toast.error(
          error instanceof NetworkError
            ? 'Couldn’t update the job. Check your connection and try again.'
            : errorMessage(error),
        )
      },
    })
  }

  function press(name: ActionName) {
    if (name === 'start') run({ action: 'start' })
    else setSheet(name)
  }

  if (job.status === 'no_access') {
    return <p className="text-muted-foreground">The office will reschedule this visit.</p>
  }
  if (job.status === 'done') {
    return <p className="text-muted-foreground">Done at {job.completedLabel}.</p>
  }
  const [main, ...more] = BUTTONS[job.status] ?? []
  if (!main) return null

  const label = (name: ActionName) => (
    <>
      {busy && action.variables?.action === name && <Loader2 className="animate-spin" />}
      {LABELS[name]}
    </>
  )

  return (
    <div className="space-y-2">
      <Button className="h-12 w-full text-base" disabled={busy} onClick={() => press(main)}>
        {label(main)}
      </Button>
      {more.length > 0 && (
        <div className={cn('grid gap-2', more.length === 3 ? 'grid-cols-3' : 'grid-cols-2')}>
          {more.map((name) => (
            <Button
              key={name}
              variant="outline"
              className="h-11 px-2"
              disabled={busy}
              onClick={() => press(name)}
            >
              {label(name)}
            </Button>
          ))}
        </div>
      )}

      <MinutesSheet
        open={sheet === 'on-my-way'}
        title="How far away are you?"
        description="We’ll text the homeowner your arrival time."
        minutes={ARRIVAL_MINUTES}
        busy={busy}
        onPick={(minutes) => run({ action: 'on-my-way', minutes })}
        onClose={() => setSheet(null)}
      />
      <MinutesSheet
        open={sheet === 'running-late'}
        title="How far away are you now?"
        description="We’ll text the homeowner the new time."
        minutes={LATE_MINUTES}
        busy={busy}
        onPick={(minutes) => run({ action: 'running-late', minutes })}
        onClose={() => setSheet(null)}
      />

      <Dialog open={sheet === 'no-access'} onOpenChange={(open) => !open && setSheet(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Couldn’t get in?</DialogTitle>
            <DialogDescription>
              We’ll text the homeowner and the office will reschedule.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="no-access-note">Note (optional)</Label>
            <Textarea
              id="no-access-note"
              rows={3}
              maxLength={1000}
              placeholder="Gate locked, knocked and called at 1:30"
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setSheet(null)}>
              Cancel
            </Button>
            <Button disabled={busy} onClick={() => run({ action: 'no-access', note })}>
              {busy && <Loader2 className="animate-spin" />}
              Mark no access
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={sheet === 'complete'} onOpenChange={(open) => !open && setSheet(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mark this visit done?</DialogTitle>
            <DialogDescription>This can’t be undone.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setSheet(null)}>
              Cancel
            </Button>
            <Button disabled={busy} onClick={() => run({ action: 'complete' })}>
              {busy && <Loader2 className="animate-spin" />}
              Job complete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// Picks how far away the technician is; each choice shows the clock time it means.
function MinutesSheet(props: {
  open: boolean
  title: string
  description: string
  minutes: number[]
  busy: boolean
  onPick: (minutes: number) => void
  onClose: () => void
}) {
  const now = new Date()
  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          <DialogDescription>{props.description}</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-2">
          {props.minutes.map((minutes) => (
            <Button
              key={minutes}
              variant="outline"
              className="h-12"
              disabled={props.busy}
              onClick={() => props.onPick(minutes)}
            >
              {arrivalPreview(now, minutes)}
            </Button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 7: Put them on the job page**

In `relay-web/src/features/technician-jobs/job-details.tsx`:

Add the import:

```tsx
import { JobActions } from './job-actions'
```

In the first `<Section>` (the header), add after the `{job.service.name} · …` paragraph:

```tsx
        {job.etaLabel && (
          <p className="font-medium text-sky-800">Arriving about {job.etaLabel}</p>
        )}
```

Add a new section right after that first `</Section>`:

```tsx
      <Section>
        <JobActions job={job} />
      </Section>
```

- [ ] **Step 8: Typecheck, test, lint, commit**

```bash
npm run typecheck
npm test
npx biome check --write src/features/technician-jobs/api.ts src/features/technician-jobs/arrival.ts src/features/technician-jobs/arrival.test.ts src/features/technician-jobs/job-actions.tsx src/features/technician-jobs/job-details.tsx
git add src/features/technician-jobs
git commit -m "feat: add the technician's status buttons"
```

Expected: typecheck prints nothing; tests pass; Biome reports no errors. (`job-list.tsx` still compiles: it only reads fields that still exist; Task 6 uses the new ones.)

---

### Task 6: Web — Earlier section and arrival times on the list, the board and the drawer

**Files:**
- Modify: `relay-web/src/features/technician-jobs/job-list.tsx` (whole file)
- Modify: `relay-web/src/features/dispatch/api.ts` (`BoardJob`, `JobDetail`)
- Modify: `relay-web/src/features/dispatch/job-card.tsx` (after the customer name)
- Modify: `relay-web/src/features/dispatch/job-drawer.tsx` (`JobDetails` header)

**Interfaces:**
- Consumes: `MyJobCard`, `useMyJobs` (Task 5); board and drawer `etaLabel` (Task 1).
- Produces: nothing new for later tasks.

- [ ] **Step 1: Rewrite the list with sections**

Replace `relay-web/src/features/technician-jobs/job-list.tsx` with:

```tsx
import { cn } from 'cn'
import { ChevronRight, Loader2 } from 'lucide-react'
import { Link } from 'react-router'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { STATUS } from '@/features/dispatch/labels'
import { errorMessage } from '@/lib/errors'
import { type MyJobCard, useMyJobs } from './api'

// The technician's jobs: unfinished ones from earlier days first, then today and the next 6
// days. Each card opens the job.
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
  const { earlier, days } = list.data
  if (earlier.length === 0 && days.length === 0) {
    return <p className="text-muted-foreground">No jobs assigned to you for the next 7 days.</p>
  }

  return (
    <div className="space-y-6">
      {earlier.length > 0 && <JobSection title="Earlier" jobs={earlier} showDay />}
      {days.map((day) => (
        <JobSection key={day.date} title={day.label} jobs={day.jobs} />
      ))}
    </div>
  )
}

function JobSection(props: { title: string; jobs: MyJobCard[]; showDay?: boolean }) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold text-muted-foreground">{props.title}</h2>
      <ul className="space-y-2">
        {props.jobs.map((job) => (
          <li key={job.id}>
            <JobCard job={job} showDay={props.showDay} />
          </li>
        ))}
      </ul>
    </section>
  )
}

function JobCard({ job, showDay }: { job: MyJobCard; showDay?: boolean }) {
  return (
    <Link
      to={`/jobs/${job.id}`}
      className={cn(
        'flex items-center gap-3 rounded-xl bg-card p-4 shadow-sm outline-none transition-shadow hover:shadow-md focus-visible:ring-3 focus-visible:ring-ring/50',
        job.status === 'done' && 'opacity-60',
      )}
    >
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-semibold">
            {showDay ? `${job.dateLabel} · ${job.windowLabel}` : job.windowLabel}
          </span>
          {job.priority && <Badge className="bg-red-600 text-white">PRIORITY</Badge>}
          <Badge className={STATUS[job.status].chip}>{STATUS[job.status].label}</Badge>
        </div>
        <p className="font-medium">{job.customerName}</p>
        <p className="truncate text-sm text-muted-foreground">
          {job.street}, {job.city} · {job.serviceName}
        </p>
        {job.etaLabel && (
          <p className="text-sm font-medium text-sky-800">Arriving about {job.etaLabel}</p>
        )}
      </div>
      <ChevronRight className="size-5 shrink-0 text-muted-foreground" />
    </Link>
  )
}
```

- [ ] **Step 2: Show the arrival time to the office**

In `relay-web/src/features/dispatch/api.ts`, add to `BoardJob` after `windowLabel: z.string(),`:

```ts
  etaLabel: z.string().nullable(), // '9:10 AM' once the technician gave a time
```

and to `JobDetail`'s `job` after `windowLabel: z.string(),`:

```ts
    etaLabel: z.string().nullable(),
```

In `relay-web/src/features/dispatch/job-card.tsx`, add after the `{job.customerName}` paragraph:

```tsx
      {job.etaLabel && (
        <p className="text-xs font-medium text-sky-800">Arriving about {job.etaLabel}</p>
      )}
```

In `relay-web/src/features/dispatch/job-drawer.tsx`, in `JobDetails`'s `<SheetHeader>`, add after the `</SheetDescription>` that shows the service, day and window:

```tsx
        {job.etaLabel && (
          <p className="text-sm font-medium text-sky-800">Arriving about {job.etaLabel}</p>
        )}
```

- [ ] **Step 3: Typecheck, test, lint, commit**

```bash
npm run typecheck
npm test
npx biome check --write src/features/technician-jobs/job-list.tsx src/features/dispatch/api.ts src/features/dispatch/job-card.tsx src/features/dispatch/job-drawer.tsx
git add src/features/technician-jobs/job-list.tsx src/features/dispatch/api.ts src/features/dispatch/job-card.tsx src/features/dispatch/job-drawer.tsx
git commit -m "feat: show earlier jobs and arrival times to technicians and the office"
```

---

### Task 7: Check it in the running app

**Files:** none in the repos (scripts and screenshots go to the session scratchpad).

- [ ] **Step 1: Sign in as Sam Patel at phone width with a job assigned**

Sign in as `office@desert.test` and assign two of today's booked jobs to Sam Patel. In a 390 px window, sign in at `/sign-in/phone` as `(480) 555-0301` (code in the relay-api terminal) and open the first job.
Expected: the job page shows On my way as the main button, with Running late, Start job and No access under it.

- [ ] **Step 2: Walk one job through every button, with the board open**

Keep the office's dispatch board open in a second window on today.
1. On my way → pick 15 min. Expected: status En route, "Arriving about <time>" on the job page and on the board card within a second.
2. Running late → pick 30 min. Expected: a later "Arriving about" time on both.
3. Start job. Expected: In progress, no arrival time; only Job complete shows.
4. Job complete → confirm. Expected: Done, "Done at <time>."

- [ ] **Step 3: No access on the second job**

Open the second job → No access → write a note → Mark no access.
Expected: "The office will reschedule this visit."; the note shows under Office notes with Sam's name; the board shows No access.

- [ ] **Step 4: Check the saved texts**

In the dev database (`messages`, newest first): three texts for these taps (`on_my_way`, `running_late`, `no_access`) to the homeowners' numbers, with the times shown on screen. None for Start job or Job complete.

- [ ] **Step 5: Report**

Report the screenshots and anything that didn't match.
