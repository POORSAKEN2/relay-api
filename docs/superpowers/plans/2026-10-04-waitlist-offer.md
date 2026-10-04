# Waitlist Offer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an arrival window has a free place, text the next homeowner on the waitlist a link that books it, and hold that place for them for 30 minutes.

**Architecture:** A pg-boss job (`waitlist-offers`, every minute) tidies the waitlist, hands out
offers that ran out, and offers each free place to the next homeowner in line. An open offer is
stored on its `waitlist_entries` row and counts as a taken place in both window counts
(`reserveWindow` and the booking calendar). The offer link (`/?offer=<token>`) opens the booking
wizard filled in, and the booking sends `offerToken` so the held place doesn't count against its
holder.

**Tech Stack:** relay-api: Node 22, Express 5, Drizzle ORM (Postgres), pg-boss, zod, vitest +
supertest against the test database. relay-web: React, TanStack Query, react-router, zod, vitest.

**Spec:** `relay-api/docs/superpowers/specs/2026-10-04-waitlist-offer-design.md`

## Global Constraints

- Branch `feat/waitlist-offer` in **both** repos, cut from `feat/booking-manage-link`. relay-api
  already has it; create it in relay-web in Task 7. Leave the user's uncommitted
  `relay-api/.env.example` and untracked `relay-web/src/features/auth/landing.test.ts` alone.
- Hold: **30 minutes** (`WAITLIST_OFFER_MINUTES = 30`). Taken off after **2** missed offers
  (`WAITLIST_MAX_MISSED = 2`). Entries last **14 days** (`ends_at`, default `now() + 14 days`).
- Only places starting **at least 2 hours** from now are offered, in the next **14** days.
- Line order: `priority desc, created_at asc`. One open offer per free place.
- No new offers during the contractor's quiet hours (`quietUntil`). Suspended contractors get no
  offers (`tenants.status <> 'suspended'`, like booking recovery).
- Offer text, exactly: `<tenant name>: a time opened up: <Tue, Oct 7>, <8 AM - 12 PM>. It's yours
  for 30 minutes: <link> Reply STOP to opt out.` Link: `tenantUrl(tenant, '/?offer=<token>')`.
- Taken-off text, exactly: `<tenant name>: we've taken you off the waitlist. Book anytime:
  <tenantUrl(tenant, '/')> Reply STOP to opt out.`
- Both texts are kind `waitlist_offer`, sent with `sendText` inside the transaction that changes
  the entry.
- Ended-offer API error: 404 `not_found`, `This offer has ended. Pick another time, or call
  <formatPhone(contactPhone)>.`
- Comments in plain English, matching the surrounding code. No new dependencies.
- Every commit message ends with:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- Before each commit: `npm run lint` and `npm run typecheck` pass in the repo you changed.

## Review Focus

1. **A homeowner whose offer ran out is first in line again**, so the same run would offer
   them the same place again. Expected: that place goes to the next homeowner. This is why
   `missed_window_starts_at` exists (an extra column beyond the spec's list). Test in Task 4.
2. **The office deletes a window while an offer on it is open.** Expected: the offer link says
   the offer has ended, and nothing crashes. Test in Task 6.
3. **A waiting homeowner's customer record has no phone any more** (the office cleared it).
   Expected: they are skipped, and the next homeowner gets the place. Test in Task 4.
4. **Two job runs, or a run and a booking, at the same moment for the last place.** Expected:
   exactly one wins, and the window is never over its cap. Test in Task 4.
5. **A made-up or wrong offer token on a booking.** Expected: it is ignored, so the held place
   still counts as taken for everyone but its holder. Test in Task 6.

---

## File map

relay-api:

- Modify `src/db/schema.ts`: the `waitlist_entries` columns, the `expired` status, the
  constants.
- Create `drizzle/0014_waitlist_offers.sql` (generated) and its snapshot/journal.
- Modify `src/modules/booking/booking.queries.ts`: `countOpenOffersAt`.
- Modify `src/modules/booking/booking.service.ts`: `reserveWindow` counts offers.
- Modify `src/modules/online-booking/online-booking.queries.ts`: `listOpenWindows` counts offers.
- Modify `src/modules/online-booking/online-booking.service.ts`: `reserveOpenWindow`,
  `listOpenWindows`, `joinWaitlist`, `bookVisit`.
- Modify `src/modules/online-booking/online-booking.schemas.ts`: `offerToken`.
- Modify `src/modules/online-booking/online-booking.routes.ts`: `GET offers/:token`,
  `windows?offer=`.
- Create `src/modules/online-booking/waitlist-texts.ts`: the two text bodies (pure).
- Create `src/modules/online-booking/waitlist.queries.ts`: every waitlist query.
- Create `src/modules/online-booking/waitlist.service.ts`: the job, `getOffer`,
  `findOpenOfferId`.
- Modify `src/jobs/index.ts`: register `waitlist-offers`.
- Tests: create `src/modules/online-booking/waitlist-texts.test.ts` and
  `src/modules/online-booking/waitlist.test.ts`.

relay-web:

- Modify `src/features/booking/api.ts`: `Offer`, `useOffer`, `useOpenWindows(offerToken)`,
  `BookingInput.offerToken`.
- Modify `src/features/booking/steps.ts`: `answersFromOffer`.
- Modify `src/features/booking/booking-flow.tsx`: read `?offer=`, the banner, pass the offer on.
- Modify `src/features/booking/time-step.tsx`: the offer's calendar and the "held" note.
- Modify `src/features/booking/details-step.tsx`: send `offerToken`.
- Test: `src/features/booking/steps.test.ts`.

---

### Task 1: Schema and migration

**Files:**
- Modify: `relay-api/src/db/schema.ts:784-816` (`WAITLIST_STATUSES`, `waitlistEntries`)
- Create: `relay-api/drizzle/0014_waitlist_offers.sql` (generated)
- Create: `relay-api/src/modules/online-booking/waitlist.test.ts`

**Interfaces:**
- Produces: `WAITLIST_STATUSES` with `'expired'`; `WAITLIST_OFFER_MINUTES = 30`;
  `WAITLIST_MAX_MISSED = 2`; columns `endsAt`, `offerWindowId`, `offerDate` (string
  `'YYYY-MM-DD'`), `offerWindowStartsAt`, `offerExpiresAt`, `offerLinkHash`, `offersMissed`,
  `missedWindowStartsAt` on `waitlistEntries`. The test file's helpers (`createWaitlistShop`,
  `join`, `fillPlace`, `localMoment`, `entries`, `offerTexts`, `tokenIn`, `get`, `post`,
  `bookingBody`) are used by Tasks 2, 4, 5 and 6.

- [ ] **Step 1: Write the test file with its helpers and the failing tests**

Create `relay-api/src/modules/online-booking/waitlist.test.ts`:

```ts
import { randomBytes } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createJob, createShop, resetDb } from '../../../test/helpers.ts'
import { createApp } from '../../app.ts'
import { db } from '../../db/client.ts'
import {
  arrivalWindows,
  consentEvents,
  customers,
  jobs,
  messages,
  serviceAreaZips,
  tenants,
  waitlistEntries,
} from '../../db/schema.ts'
import { weekdayOf } from '../../lib/labels.ts'
import { hashLinkToken } from '../../lib/link-token.ts'

vi.mock('../../realtime/index.ts', () => ({ emitToTenant: vi.fn() }))

const app = createApp()

beforeEach(async () => {
  await resetDb()
})

function get(path: string, slug = 'desert') {
  return request(app).get(`/api/online-booking/${path}`).set('X-Tenant-Host', `${slug}.localhost`)
}

function post(path: string, body: Record<string, unknown>, slug = 'desert') {
  return request(app)
    .post(`/api/online-booking/${path}`)
    .set('X-Tenant-Host', `${slug}.localhost`)
    .send(body)
}

// A timezone where it is about noon right now: quiet hours (9 PM–8 AM) never get in the way,
// and today still has its afternoon ahead.
function middayTimezone() {
  const offset = 12 - new Date().getUTCHours() // local = UTC + offset
  if (offset === 0) return 'Etc/UTC'
  // Etc/GMT names count the other way round: Etc/GMT-5 is UTC+5.
  return offset > 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`
}

// The local date `days` from today in `timezone`, e.g. '2026-10-06'.
function localDate(timezone: string, days: number) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(
    new Date(Date.now() + days * 86_400_000),
  )
}

// The moment a local date and time happen in `timezone`.
async function localMoment(timezone: string, date: string, time: string) {
  const result = await db.execute<{ at: string }>(sql`
    select to_char(
      ((${date}::date + ${time}::time) at time zone ${timezone}) at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS"Z"'
    ) as at
  `)
  return new Date(result.rows[0].at)
}

// A contractor serving 85201 where it is about noon, with one arrival window, 8–12 with room for
// 1 job, on the weekday two days from now. In the next two weeks that window opens on two dates:
// `soon` (in 2 days) and `later` (in 9 days).
async function createWaitlistShop(slug = 'desert') {
  const shop = await createShop(slug)
  const timezone = middayTimezone()
  await db.update(tenants).set({ timezone }).where(eq(tenants.id, shop.tenant.id))
  await db.insert(serviceAreaZips).values({ tenantId: shop.tenant.id, zip: '85201' })
  await db.delete(arrivalWindows).where(eq(arrivalWindows.tenantId, shop.tenant.id))
  const soon = localDate(timezone, 2)
  const [window] = await db
    .insert(arrivalWindows)
    .values({
      tenantId: shop.tenant.id,
      weekday: weekdayOf(soon),
      startsAt: '08:00',
      endsAt: '12:00',
      jobCap: 1,
    })
    .returning()
  return { ...shop, timezone, window, soon, later: localDate(timezone, 9) }
}

type WaitlistShop = Awaited<ReturnType<typeof createWaitlistShop>>

// Joins the waitlist the way the booking page does.
async function join(
  shop: WaitlistShop,
  who: { name: string; phone: string; vulnerableOccupant?: boolean },
) {
  await post(
    'waitlist',
    { serviceId: shop.service.id, zip: '85201', vulnerableOccupant: false, consent: true, ...who },
    shop.tenant.slug,
  ).expect(201)
}

// A job in the window on `date`, so its place isn't free. Returns the job.
async function fillPlace(shop: WaitlistShop, date: string, startsAt = '08:00', endsAt = '12:00') {
  return createJob(shop, {
    windowStartsAt: await localMoment(shop.timezone, date, startsAt),
    windowEndsAt: await localMoment(shop.timezone, date, endsAt),
  })
}

function entries() {
  return db.select().from(waitlistEntries).orderBy(waitlistEntries.createdAt)
}

function offerTexts() {
  return db
    .select()
    .from(messages)
    .where(eq(messages.kind, 'waitlist_offer'))
    .orderBy(messages.createdAt)
}

// The link token in an offer text.
function tokenIn(body: string) {
  return /\?offer=([\w-]+)/.exec(body)![1]
}

function bookingBody(shop: WaitlistShop, overrides: Record<string, unknown> = {}) {
  return {
    serviceId: shop.service.id,
    date: shop.soon,
    windowId: shop.window.id,
    problem: 'No cooling since last night',
    systemType: 'central_ac',
    name: 'Sam Reed',
    phone: '(480) 555-0199',
    street: '4 Cactus Rd',
    city: 'Mesa',
    state: 'az',
    zip: '85201',
    consent: true,
    ...overrides,
  }
}

// An open offer straight in the database, for the hold's tests (before the job exists).
async function insertOffer(shop: WaitlistShop, date: string, expiresInMinutes = 30) {
  const [entry] = await db
    .insert(waitlistEntries)
    .values({
      tenantId: shop.tenant.id,
      customerId: shop.customer.id,
      serviceId: shop.service.id,
      zip: '85201',
      status: 'offered',
      offerWindowId: shop.window.id,
      offerDate: date,
      offerWindowStartsAt: await localMoment(shop.timezone, date, '08:00'),
      offerExpiresAt: new Date(Date.now() + expiresInMinutes * 60_000),
      offerLinkHash: hashLinkToken(randomBytes(18).toString('base64url')),
    })
    .returning()
  return entry
}

describe('waitlist_entries', () => {
  it('gives a new entry 14 days and no missed offers', async () => {
    const shop = await createWaitlistShop()
    await join(shop, { name: 'Ann Early', phone: '(480) 555-0101' })

    const [entry] = await entries()
    expect(entry).toMatchObject({ status: 'waiting', offersMissed: 0, offerLinkHash: null })
    const days = (entry.endsAt.getTime() - entry.createdAt.getTime()) / 86_400_000
    expect(days).toBeCloseTo(14, 2)
  })

  it('refuses an offered entry without its offer', async () => {
    const shop = await createWaitlistShop()
    await expect(
      db.insert(waitlistEntries).values({
        tenantId: shop.tenant.id,
        customerId: shop.customer.id,
        serviceId: shop.service.id,
        zip: '85201',
        status: 'offered',
      }),
    ).rejects.toMatchObject({ cause: { constraint: 'waitlist_entries_offer_complete' } })
  })
})
```

Unused imports (`consentEvents`, `customers`, `jobs`, `insertOffer`, `bookingBody`, `tokenIn`,
`offerTexts`, `fillPlace`) are used by later tasks. If `npm run lint` complains before then,
leave the ones not yet used out and add them back in the task that needs them.

- [ ] **Step 2: Run the tests to check they fail**

Run (in `relay-api`): `npx vitest run src/modules/online-booking/waitlist.test.ts`
Expected: FAIL. TypeScript/runtime errors: `endsAt` and `offersMissed` don't exist, and the
`offered` insert succeeds instead of being refused.

- [ ] **Step 3: Change the schema**

In `relay-api/src/db/schema.ts`, replace the `WAITLIST_STATUSES` line and the `waitlistEntries`
table (lines 784-816) with:

```ts
// 'removed': texted STOP. 'expired': 14 days passed, or too many offers ran out.
export const WAITLIST_STATUSES = ['waiting', 'offered', 'booked', 'removed', 'expired'] as const
// How long a place offered from the waitlist is held, and how many offers may run out before
// the homeowner is taken off.
export const WAITLIST_OFFER_MINUTES = 30
export const WAITLIST_MAX_MISSED = 2

export const waitlistEntries = pgTable(
  'waitlist_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    customerId: uuid('customer_id').notNull(),
    serviceId: uuid('service_id').notNull(),
    zip: text('zip').notNull(),
    priority: boolean('priority').notNull().default(false), // lets "first-come or priority-first" go either way
    status: text('status', { enum: WAITLIST_STATUSES }).notNull().default('waiting'),
    offeredAt: timestamptz('offered_at'),
    createdAt: createdAt(),
    // Joined (or joined again) + 14 days. created_at stays, so joining again keeps the place
    // in line.
    endsAt: timestamptz('ends_at')
      .notNull()
      .default(sql`now() + interval '14 days'`),
    // The open offer, set only while status = 'offered'. No foreign key on the window: the
    // office may delete one in settings, and the offer then just stops working.
    offerWindowId: uuid('offer_window_id'),
    offerDate: date('offer_date'),
    offerWindowStartsAt: timestamptz('offer_window_starts_at'), // matched against jobs.window_starts_at
    offerExpiresAt: timestamptz('offer_expires_at'),
    offerLinkHash: text('offer_link_hash').unique(), // sha256 of the link's token
    offersMissed: smallint('offers_missed').notNull().default(0),
    // The place of the offer that last ran out, so it goes to the next homeowner in line
    // instead of straight back to this one.
    missedWindowStartsAt: timestamptz('missed_window_starts_at'),
  },
  (t) => [
    foreignKey({
      name: 'waitlist_entries_customer_fk',
      columns: [t.tenantId, t.customerId],
      foreignColumns: [customers.tenantId, customers.id],
    }),
    foreignKey({
      name: 'waitlist_entries_service_fk',
      columns: [t.tenantId, t.serviceId],
      foreignColumns: [services.tenantId, services.id],
    }),
    check('waitlist_entries_status_valid', oneOf(t.status, WAITLIST_STATUSES)),
    check('waitlist_entries_zip_format', sql`${t.zip} ~ '^[0-9]{5}$'`),
    check(
      'waitlist_entries_offer_complete',
      sql`(${t.status} = 'offered') = (${t.offerWindowId} is not null and ${t.offerDate} is not null and ${t.offerWindowStartsAt} is not null and ${t.offerExpiresAt} is not null and ${t.offerLinkHash} is not null)`,
    ),
    check('waitlist_entries_offers_missed_range', sql`${t.offersMissed} between 0 and 2`),
    index('waitlist_entries_waiting_idx')
      .on(t.tenantId, t.createdAt)
      .where(sql`${t.status} = 'waiting'`),
    index('waitlist_entries_offered_idx')
      .on(t.tenantId, t.offerWindowStartsAt)
      .where(sql`${t.status} = 'offered'`),
  ],
)
```

Check that `date` and `smallint` are already imported from `drizzle-orm/pg-core` at the top of
`schema.ts` (they are used elsewhere in the file).

- [ ] **Step 4: Generate and apply the migration**

Run (in `relay-api`): `npm run db:generate -- --name waitlist_offers`
Expected: `drizzle/0014_waitlist_offers.sql` with `ADD COLUMN` for the 8 columns, the unique
constraint on `offer_link_hash`, the new index, `DROP`/`ADD` of `waitlist_entries_status_valid`,
and the two new checks. Read it. If drizzle-kit asks an interactive rename question, answer
"create column" for every new column.

Run: `npm run db:migrate` (development database). The test database is migrated by
`test/global-setup.ts` when the tests start. Check that file does this. If it doesn't, run the
migration against `TEST_DATABASE_URL` the same way the README says.

- [ ] **Step 5: Run the tests to check they pass**

Run: `npx vitest run src/modules/online-booking/waitlist.test.ts`
Expected: PASS (2 tests). Then `npx vitest run src/modules/online-booking` to check the existing
waitlist test in `online-booking.test.ts` still passes.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts drizzle/0014_waitlist_offers.sql drizzle/meta src/modules/online-booking/waitlist.test.ts
git commit -m "feat: waitlist entries can hold an offer

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: An open offer holds its place

**Files:**
- Modify: `relay-api/src/modules/booking/booking.queries.ts` (after `countActiveJobsAt`, line ~78)
- Modify: `relay-api/src/modules/booking/booking.service.ts:21-60` (`Reserve`, `reserveWindow`)
- Modify: `relay-api/src/modules/online-booking/online-booking.queries.ts:36-56` (`listOpenWindows`)
- Modify: `relay-api/src/modules/online-booking/online-booking.service.ts:436-466` (`reserveOpenWindow`)
- Test: `relay-api/src/modules/online-booking/waitlist.test.ts`

**Interfaces:**
- Consumes: Task 1's columns.
- Produces:
  - `countOpenOffersAt(tenantId: string, startsAt: Date, excludeOfferId: string | undefined, tx?: Db): Promise<number>` in `booking.queries.ts`
  - `Reserve = { allowOverCap: boolean; excludeJobId?: string; excludeOfferId?: string }`
  - `reserveOpenWindow(tx, tenantId, windowId, date, excludeJobId?: string, excludeOfferId?: string)`
  - `listOpenWindows(tenantId: string, days: number, offerId?: string)` in `online-booking.queries.ts`

- [ ] **Step 1: Write the failing tests**

Append to `waitlist.test.ts`:

```ts
describe('the hold', () => {
  it('hides a held place from the calendar', async () => {
    const shop = await createWaitlistShop()
    await insertOffer(shop, shop.soon)

    const res = await get('windows').expect(200)
    expect(res.body.days.map((day: { date: string }) => day.date)).toEqual([shop.later])
  })

  it('refuses to book a held place for anyone else', async () => {
    const shop = await createWaitlistShop()
    await insertOffer(shop, shop.soon)

    const res = await post('bookings', bookingBody(shop)).expect(409)
    expect(res.body.error.code).toBe('window_full')
  })

  it('frees the place the moment the offer runs out', async () => {
    const shop = await createWaitlistShop()
    await insertOffer(shop, shop.soon, -1)

    await post('bookings', bookingBody(shop)).expect(201)
  })
})
```

- [ ] **Step 2: Run them to check they fail**

Run: `npx vitest run src/modules/online-booking/waitlist.test.ts -t "the hold"`
Expected: the first two FAIL (the place still shows, and the booking gets 201); the third PASSES.

- [ ] **Step 3: Count open offers when booking**

In `booking.queries.ts`, add `waitlistEntries` to the schema import and `gt` to the
`drizzle-orm` import, then add after `countActiveJobsAt`:

```ts
// Waitlist offers holding a place in the window that starts at `startsAt`, until they run out.
// `excludeOfferId`: the homeowner booking from that offer doesn't count against themselves.
export async function countOpenOffersAt(
  tenantId: string,
  startsAt: Date,
  excludeOfferId: string | undefined,
  tx: Db = db,
) {
  const [row] = await tx
    .select({ count: count() })
    .from(waitlistEntries)
    .where(
      and(
        eq(waitlistEntries.tenantId, tenantId),
        eq(waitlistEntries.status, 'offered'),
        eq(waitlistEntries.offerWindowStartsAt, startsAt),
        gt(waitlistEntries.offerExpiresAt, sql`now()`),
        excludeOfferId ? ne(waitlistEntries.id, excludeOfferId) : undefined,
      ),
    )
  return row.count
}
```

In `booking.service.ts`, change `Reserve` and the count in `reserveWindow`:

```ts
type Reserve = { allowOverCap: boolean; excludeJobId?: string; excludeOfferId?: string }
```

```ts
  { allowOverCap, excludeJobId, excludeOfferId }: Reserve,
```

```ts
  // Jobs, plus places held for a homeowner from the waitlist.
  const booked =
    (await queries.countActiveJobsAt(tenantId, window.windowStartsAt, excludeJobId, tx)) +
    (await queries.countOpenOffersAt(tenantId, window.windowStartsAt, excludeOfferId, tx))
```

In `online-booking.service.ts`, `reserveOpenWindow` takes and passes the offer:

```ts
// `excludeJobId`: a visit being moved doesn't count against its own new window.
// `excludeOfferId`: nor does a place held for the homeowner booking from that offer.
export async function reserveOpenWindow(
  tx: Tx,
  tenantId: string,
  windowId: string,
  date: string,
  excludeJobId?: string,
  excludeOfferId?: string,
) {
  let slot: Awaited<ReturnType<typeof reserveWindow>>
  try {
    slot = await reserveWindow(tx, tenantId, windowId, date, {
      allowOverCap: false,
      excludeJobId,
      excludeOfferId,
    })
```

(The rest of the function is unchanged.)

- [ ] **Step 4: Count open offers in the calendar**

In `online-booking.queries.ts`, replace `listOpenWindows`:

```ts
// `offerId`: the homeowner holding that waitlist offer sees its place as open.
export async function listOpenWindows(tenantId: string, days: number, offerId?: string) {
  const result = await db.execute<{ date: string; id: string; startsAt: string; endsAt: string }>(
    sql`
      select to_char(d.day, 'YYYY-MM-DD') as "date", w.id, w.starts_at as "startsAt", w.ends_at as "endsAt"
      from tenants t
      cross join generate_series(0, ${days - 1}::int) as n
      cross join lateral (select (now() at time zone t.timezone)::date + n as day) d
      join arrival_windows w on w.tenant_id = t.id and w.weekday = extract(dow from d.day)
      where t.id = ${tenantId}
        and (d.day + w.starts_at) at time zone t.timezone > now()
        and w.job_cap > (
          select count(*) from jobs j
          where j.tenant_id = t.id
            and j.window_starts_at = (d.day + w.starts_at) at time zone t.timezone
            and j.status not in ('cancelled', 'expired')
        ) + (
          select count(*) from waitlist_entries o
          where o.tenant_id = t.id
            and o.status = 'offered'
            and o.offer_window_starts_at = (d.day + w.starts_at) at time zone t.timezone
            and o.offer_expires_at > now()
            ${offerId ? sql`and o.id <> ${offerId}` : sql``}
        )
      order by d.day, w.starts_at
    `,
  )
  return result.rows
}
```

- [ ] **Step 5: Run the tests to check they pass**

Run: `npx vitest run src/modules/online-booking src/modules/booking src/modules/dispatch`
Expected: PASS, including the existing booking, reschedule and office move tests.

- [ ] **Step 6: Commit**

```bash
git add src/modules/booking src/modules/online-booking
git commit -m "feat: an open waitlist offer holds its place in the window

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The two texts

**Files:**
- Create: `relay-api/src/modules/online-booking/waitlist-texts.ts`
- Test: `relay-api/src/modules/online-booking/waitlist-texts.test.ts`

**Interfaces:**
- Consumes: `WAITLIST_OFFER_MINUTES` (Task 1).
- Produces: `offerText(offer: { tenantName: string; dayLabel: string; windowLabel: string; link: string }): string` and `takenOffText(notice: { tenantName: string; link: string }): string`.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, it } from 'vitest'
import { offerText, takenOffText } from './waitlist-texts.ts'

it('offers the place with its link and how long it is held', () => {
  expect(
    offerText({
      tenantName: 'Desert Breeze Air',
      dayLabel: 'Tue, Oct 7',
      windowLabel: '8 AM - 12 PM',
      link: 'https://desert.garified.com/?offer=Xk3',
    }),
  ).toBe(
    "Desert Breeze Air: a time opened up: Tue, Oct 7, 8 AM - 12 PM. It's yours for 30 minutes: https://desert.garified.com/?offer=Xk3 Reply STOP to opt out.",
  )
})

it('says the homeowner is off the waitlist, with the booking page', () => {
  expect(
    takenOffText({ tenantName: 'Desert Breeze Air', link: 'https://desert.garified.com/' }),
  ).toBe(
    "Desert Breeze Air: we've taken you off the waitlist. Book anytime: https://desert.garified.com/ Reply STOP to opt out.",
  )
})
```

- [ ] **Step 2: Run it to check it fails**

Run: `npx vitest run src/modules/online-booking/waitlist-texts.test.ts`
Expected: FAIL, "Failed to resolve import ./waitlist-texts.ts".

- [ ] **Step 3: Write the texts**

```ts
import { WAITLIST_OFFER_MINUTES } from '../../db/schema.ts'

// The texts a homeowner on the waitlist gets. Plain ASCII (no en dash, no curly quote), so a
// text stays in the cheaper SMS encoding.

export function offerText(offer: {
  tenantName: string
  dayLabel: string // 'Tue, Oct 7'
  windowLabel: string // '8 AM - 12 PM', from textWindow
  link: string
}) {
  return `${offer.tenantName}: a time opened up: ${offer.dayLabel}, ${offer.windowLabel}. It's yours for ${WAITLIST_OFFER_MINUTES} minutes: ${offer.link} Reply STOP to opt out.`
}

// After the last offer ran out.
export function takenOffText(notice: { tenantName: string; link: string }) {
  return `${notice.tenantName}: we've taken you off the waitlist. Book anytime: ${notice.link} Reply STOP to opt out.`
}
```

- [ ] **Step 4: Run it to check it passes**

Run: `npx vitest run src/modules/online-booking/waitlist-texts.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/online-booking/waitlist-texts.ts src/modules/online-booking/waitlist-texts.test.ts
git commit -m "feat: waitlist offer and taken-off texts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The `waitlist-offers` job

**Files:**
- Create: `relay-api/src/modules/online-booking/waitlist.queries.ts`
- Create: `relay-api/src/modules/online-booking/waitlist.service.ts`
- Modify: `relay-api/src/jobs/index.ts` (after `booking-recovery`)
- Test: `relay-api/src/modules/online-booking/waitlist.test.ts`

**Interfaces:**
- Consumes: `countOpenOffersAt`, `countActiveJobsAt`, `lockWindow` (`booking.queries.ts`);
  `offerText`, `takenOffText` (Task 3); `sendText` (`messaging/sms.ts`); `quietUntil`
  (`messaging/rules.ts`); `newLinkToken`; `tenantUrl`; `formatDay`, `textWindow`.
- Produces: `sendWaitlistOffers(): Promise<{ offered: number; expired: number }>` (`expired` =
  offers that ran out in this run). In `waitlist.queries.ts`: `NO_OFFER` and the queries
  below, which Tasks 5 and 6 add to.

- [ ] **Step 1: Write the failing tests**

Add `import { sendWaitlistOffers } from './waitlist.service.ts'` to the imports of
`waitlist.test.ts`, then append:

```ts
// Makes every open offer run out now, as if 30 minutes had passed.
async function runOut() {
  await db
    .update(waitlistEntries)
    .set({ offerExpiresAt: new Date(Date.now() - 60_000) })
    .where(eq(waitlistEntries.status, 'offered'))
}

describe('sendWaitlistOffers', () => {
  it('offers the soonest open place to the first in line, priority first', async () => {
    const shop = await createWaitlistShop()
    await join(shop, { name: 'Ann Early', phone: '(480) 555-0101' })
    await join(shop, { name: 'Bo Priority', phone: '(480) 555-0102', vulnerableOccupant: true })
    await fillPlace(shop, shop.later)

    expect(await sendWaitlistOffers()).toEqual({ offered: 1, expired: 0 })

    const [ann, bo] = await entries()
    expect(ann).toMatchObject({ status: 'waiting', offerDate: null })
    expect(bo).toMatchObject({ status: 'offered', offerDate: shop.soon, offerWindowId: shop.window.id })
    expect(bo.offerExpiresAt!.getTime() - Date.now()).toBeGreaterThan(29 * 60_000)
    const [text] = await offerTexts()
    expect(text).toMatchObject({ contact: '+14805550102', customerId: bo.customerId, status: 'queued' })
    expect(text.body).toMatch(
      /^desert HVAC: a time opened up: \w{3}, \w{3} \d{1,2}, 8 AM - 12 PM\. It's yours for 30 minutes: https:\/\/desert\.localhost\/\?offer=[\w-]+ Reply STOP to opt out\.$/,
    )
    expect(hashLinkToken(tokenIn(text.body))).toBe(bo.offerLinkHash)
  })

  it('offers each open place once, soonest first, to whoever joined first', async () => {
    const shop = await createWaitlistShop()
    await join(shop, { name: 'Ann Early', phone: '(480) 555-0101' })
    await join(shop, { name: 'Cy Middle', phone: '(480) 555-0103' })
    await join(shop, { name: 'Di Late', phone: '(480) 555-0104' })

    expect(await sendWaitlistOffers()).toEqual({ offered: 2, expired: 0 })
    const [ann, cy, di] = await entries()
    expect(ann.offerDate).toBe(shop.soon)
    expect(cy.offerDate).toBe(shop.later)
    expect(di.status).toBe('waiting')

    // Both places are held now: nothing more to offer.
    expect(await sendWaitlistOffers()).toEqual({ offered: 0, expired: 0 })
    expect(await offerTexts()).toHaveLength(2)
  })

  it('offers no place that starts within 2 hours', async () => {
    const shop = await createWaitlistShop()
    await join(shop, { name: 'Ann Early', phone: '(480) 555-0101' })
    await fillPlace(shop, shop.soon)
    await fillPlace(shop, shop.later)
    // It is about noon there: today's 1 PM window starts within the hour. Its date a week on
    // is taken.
    const today = localDate(shop.timezone, 0)
    const values = { tenantId: shop.tenant.id, weekday: weekdayOf(today), jobCap: 1 }
    await db.insert(arrivalWindows).values({ ...values, startsAt: '13:00', endsAt: '15:00' })
    await fillPlace(shop, localDate(shop.timezone, 7), '13:00', '15:00')

    expect(await sendWaitlistOffers()).toEqual({ offered: 0, expired: 0 })

    // 3 PM today is more than 2 hours off.
    const [later] = await db
      .insert(arrivalWindows)
      .values({ ...values, startsAt: '15:00', endsAt: '17:00' })
      .returning()
    expect(await sendWaitlistOffers()).toEqual({ offered: 1, expired: 0 })
    const [ann] = await entries()
    expect(ann).toMatchObject({ offerDate: today, offerWindowId: later.id })
  })

  it('makes no offers in quiet hours', async () => {
    const shop = await createWaitlistShop()
    await join(shop, { name: 'Ann Early', phone: '(480) 555-0101' })
    // It is about noon there.
    await db
      .update(tenants)
      .set({ quietHoursStart: '11:00', quietHoursEnd: '13:00' })
      .where(eq(tenants.id, shop.tenant.id))

    expect(await sendWaitlistOffers()).toEqual({ offered: 0, expired: 0 })
    expect(await offerTexts()).toEqual([])
  })

  it('makes no offers for a suspended contractor', async () => {
    const shop = await createWaitlistShop()
    await join(shop, { name: 'Ann Early', phone: '(480) 555-0101' })
    await db.update(tenants).set({ status: 'suspended' }).where(eq(tenants.id, shop.tenant.id))

    expect(await sendWaitlistOffers()).toEqual({ offered: 0, expired: 0 })
  })

  it('skips a homeowner with no phone any more', async () => {
    const shop = await createWaitlistShop()
    await join(shop, { name: 'Ann Early', phone: '(480) 555-0101' })
    await join(shop, { name: 'Cy Middle', phone: '(480) 555-0103' })
    await fillPlace(shop, shop.later)
    await db.update(customers).set({ phone: null }).where(eq(customers.phone, '+14805550101'))

    expect(await sendWaitlistOffers()).toEqual({ offered: 1, expired: 0 })
    const [ann, cy] = await entries()
    expect(ann.status).toBe('waiting')
    expect(cy.status).toBe('offered')
  })

  it('never lets an offer and a booking both take the last place', async () => {
    const shop = await createWaitlistShop()
    await join(shop, { name: 'Ann Early', phone: '(480) 555-0101' })
    await fillPlace(shop, shop.later)
    const soonStart = await localMoment(shop.timezone, shop.soon, '08:00')

    await Promise.all([sendWaitlistOffers(), post('bookings', bookingBody(shop))])

    const booked = await db.select().from(jobs).where(eq(jobs.windowStartsAt, soonStart))
    const held = (await entries()).filter((entry) => entry.status === 'offered')
    expect(booked.length + held.length).toBe(1)
  })

  describe('an offer that runs out', () => {
    it('keeps the homeowner in line and passes the place to the next one', async () => {
      const shop = await createWaitlistShop()
      await join(shop, { name: 'Ann Early', phone: '(480) 555-0101' })
      await join(shop, { name: 'Cy Middle', phone: '(480) 555-0103' })
      await fillPlace(shop, shop.later)
      await sendWaitlistOffers()
      await runOut()

      expect(await sendWaitlistOffers()).toEqual({ offered: 1, expired: 1 })
      const [ann, cy] = await entries()
      expect(ann).toMatchObject({ status: 'waiting', offersMissed: 1, offerLinkHash: null })
      expect(cy).toMatchObject({ status: 'offered', offerDate: shop.soon })
    })

    it('takes the homeowner off after 2, with one last text', async () => {
      const shop = await createWaitlistShop()
      await join(shop, { name: 'Ann Early', phone: '(480) 555-0101' })
      const later = await fillPlace(shop, shop.later)
      await sendWaitlistOffers()
      await runOut()
      // The same place is never offered to them twice.
      expect(await sendWaitlistOffers()).toEqual({ offered: 0, expired: 1 })

      // Another place opens: their second offer.
      await db.update(jobs).set({ status: 'cancelled' }).where(eq(jobs.id, later.id))
      expect(await sendWaitlistOffers()).toEqual({ offered: 1, expired: 0 })
      await runOut()

      expect(await sendWaitlistOffers()).toEqual({ offered: 0, expired: 1 })
      const [ann] = await entries()
      expect(ann).toMatchObject({ status: 'expired', offersMissed: 2, offerLinkHash: null })
      const texts = await offerTexts()
      expect(texts).toHaveLength(3)
      expect(texts[2].body).toBe(
        "desert HVAC: we've taken you off the waitlist. Book anytime: https://desert.localhost/ Reply STOP to opt out.",
      )
    })
  })

  describe('closing entries', () => {
    it('takes a homeowner off after 14 days, without a text', async () => {
      const shop = await createWaitlistShop()
      await join(shop, { name: 'Ann Early', phone: '(480) 555-0101' })
      await db.update(waitlistEntries).set({ endsAt: new Date(Date.now() - 60_000) })

      expect(await sendWaitlistOffers()).toEqual({ offered: 0, expired: 0 })
      const [ann] = await entries()
      expect(ann.status).toBe('expired')
      expect(await offerTexts()).toEqual([])
    })

    it('marks the entry booked once the homeowner books any visit', async () => {
      const shop = await createWaitlistShop()
      await join(shop, { name: 'Ann Early', phone: '(480) 555-0101' })
      await post('bookings', bookingBody(shop, { name: 'Ann Early', phone: '(480) 555-0101' }))
        .expect(201)

      expect(await sendWaitlistOffers()).toEqual({ offered: 0, expired: 0 })
      const [ann] = await entries()
      expect(ann.status).toBe('booked')
    })

    it('removes a homeowner who texted STOP', async () => {
      const shop = await createWaitlistShop()
      await join(shop, { name: 'Ann Early', phone: '(480) 555-0101' })
      await db.insert(consentEvents).values({
        tenantId: shop.tenant.id,
        contact: '+14805550101',
        channel: 'sms',
        granted: false,
        source: 'sms_reply',
      })

      expect(await sendWaitlistOffers()).toEqual({ offered: 0, expired: 0 })
      const [ann] = await entries()
      expect(ann.status).toBe('removed')
      expect(await offerTexts()).toEqual([])
    })
  })
})
```

- [ ] **Step 2: Run them to check they fail**

Run: `npx vitest run src/modules/online-booking/waitlist.test.ts -t sendWaitlistOffers`
Expected: FAIL, "Failed to resolve import ./waitlist.service.ts".

- [ ] **Step 3: Write the queries**

Create `relay-api/src/modules/online-booking/waitlist.queries.ts`:

```ts
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, ne, or, sql } from 'drizzle-orm'
import { type Db, db, type Tx } from '../../db/client.ts'
import {
  consentEvents,
  customers,
  jobs,
  tenants,
  WAITLIST_MAX_MISSED,
  waitlistEntries,
} from '../../db/schema.ts'

// The waitlist and its offers. Tenant-scoped, except the 'waitlist-offers' job's queries
// (closeFinishedEntries, lapseOffers, listTakenOff, listTenantsToOffer), which work on every
// contractor.

const OPEN = ['waiting', 'offered'] as const

// Clears an entry's offer.
export const NO_OFFER = {
  offerWindowId: null,
  offerDate: null,
  offerWindowStartsAt: null,
  offerExpiresAt: null,
  offerLinkHash: null,
}

// Entries that are finished: 14 days are up, the homeowner booked a visit since joining, or
// texted STOP. Returns how many were closed.
export async function closeFinishedEntries() {
  const open = inArray(waitlistEntries.status, OPEN)
  const ended = await db
    .update(waitlistEntries)
    .set({ status: 'expired', ...NO_OFFER })
    .where(and(open, lte(waitlistEntries.endsAt, sql`now()`)))
    .returning({ id: waitlistEntries.id })
  const booked = await db
    .update(waitlistEntries)
    .set({ status: 'booked', ...NO_OFFER })
    .where(
      and(
        open,
        sql`exists (
          select 1 from ${jobs}
          where ${jobs.tenantId} = ${waitlistEntries.tenantId}
            and ${jobs.customerId} = ${waitlistEntries.customerId}
            and ${jobs.status} not in ('cancelled', 'expired')
            and ${jobs.bookedAt} > ${waitlistEntries.createdAt}
        )`,
      ),
    )
    .returning({ id: waitlistEntries.id })
  const stopped = await db
    .update(waitlistEntries)
    .set({ status: 'removed', ...NO_OFFER })
    .where(
      and(
        open,
        sql`(
          select ${consentEvents.granted} from ${consentEvents}
          join ${customers} on ${customers.id} = ${waitlistEntries.customerId}
          where ${consentEvents.tenantId} = ${waitlistEntries.tenantId}
            and ${consentEvents.contact} = ${customers.phone}
            and ${consentEvents.channel} = 'sms'
          order by ${consentEvents.createdAt} desc
          limit 1
        ) = false`,
      ),
    )
    .returning({ id: waitlistEntries.id })
  return ended.length + booked.length + stopped.length
}

// Offers whose 30 minutes are up go back to 'waiting', keeping their place in line, or after
// the last one to 'expired'. The place they missed is kept so it goes to someone else.
export function lapseOffers(tx: Tx) {
  const missed = sql`${waitlistEntries.offersMissed} + 1`
  return tx
    .update(waitlistEntries)
    .set({
      ...NO_OFFER,
      missedWindowStartsAt: sql`${waitlistEntries.offerWindowStartsAt}`,
      offersMissed: missed,
      status: sql`case when ${missed} >= ${WAITLIST_MAX_MISSED} then 'expired' else 'waiting' end`,
    })
    .where(
      and(eq(waitlistEntries.status, 'offered'), lte(waitlistEntries.offerExpiresAt, sql`now()`)),
    )
    .returning({ id: waitlistEntries.id, status: waitlistEntries.status })
}

// Who to tell they are off the waitlist, with what their contractor's text needs.
export function listTakenOff(ids: string[], tx: Tx) {
  if (ids.length === 0) return Promise.resolve([])
  return tx
    .select({
      tenantId: waitlistEntries.tenantId,
      customerId: waitlistEntries.customerId,
      phone: customers.phone,
      tenantName: tenants.name,
      slug: tenants.slug,
      customDomain: tenants.customDomain,
      customDomainVerifiedAt: tenants.customDomainVerifiedAt,
    })
    .from(waitlistEntries)
    .innerJoin(customers, eq(customers.id, waitlistEntries.customerId))
    .innerJoin(tenants, eq(tenants.id, waitlistEntries.tenantId))
    .where(and(inArray(waitlistEntries.id, ids), isNotNull(customers.phone)))
}

// Contractors with homeowners waiting, unless suspended.
export function listTenantsToOffer() {
  return db
    .selectDistinct({
      id: tenants.id,
      name: tenants.name,
      slug: tenants.slug,
      customDomain: tenants.customDomain,
      customDomainVerifiedAt: tenants.customDomainVerifiedAt,
      timezone: tenants.timezone,
      quietHoursStart: tenants.quietHoursStart,
      quietHoursEnd: tenants.quietHoursEnd,
    })
    .from(tenants)
    .innerJoin(
      waitlistEntries,
      and(eq(waitlistEntries.tenantId, tenants.id), eq(waitlistEntries.status, 'waiting')),
    )
    .where(ne(tenants.status, 'suspended'))
}

// Every free place in the next `days` days that starts at least `leadMinutes` from now,
// soonest first. `free` is how many more jobs the window takes on that date.
export async function listOpenPlaces(tenantId: string, days: number, leadMinutes: number) {
  const result = await db.execute<{
    date: string
    windowId: string
    windowStartsAt: string
    windowEndsAt: string
    free: number
  }>(sql`
    select * from (
      select to_char(d.day, 'YYYY-MM-DD') as "date", w.id as "windowId",
        (d.day + w.starts_at) at time zone t.timezone as "windowStartsAt",
        (d.day + w.ends_at) at time zone t.timezone as "windowEndsAt",
        (w.job_cap - (
          select count(*) from jobs j
          where j.tenant_id = t.id
            and j.window_starts_at = (d.day + w.starts_at) at time zone t.timezone
            and j.status not in ('cancelled', 'expired')
        ) - (
          select count(*) from waitlist_entries o
          where o.tenant_id = t.id
            and o.status = 'offered'
            and o.offer_window_starts_at = (d.day + w.starts_at) at time zone t.timezone
            and o.offer_expires_at > now()
        ))::int as "free"
      from tenants t
      cross join generate_series(0, ${days - 1}::int) as n
      cross join lateral (select (now() at time zone t.timezone)::date + n as day) d
      join arrival_windows w on w.tenant_id = t.id and w.weekday = extract(dow from d.day)
      where t.id = ${tenantId}
        and (d.day + w.starts_at) at time zone t.timezone > now() + make_interval(mins => ${leadMinutes}::int)
    ) places
    where free > 0
    order by "windowStartsAt"
  `)
  // Raw queries return timestamps as text.
  return result.rows.map((row) => ({
    ...row,
    windowStartsAt: new Date(row.windowStartsAt),
    windowEndsAt: new Date(row.windowEndsAt),
  }))
}

// The next homeowner in line who hasn't just missed this place: priority first, then whoever
// joined first. Locked, and skipped by another run that has it locked, so two runs never offer
// to the same homeowner.
export async function lockNextWaiting(tenantId: string, startsAt: Date, tx: Tx) {
  const [entry] = await tx
    .select({
      id: waitlistEntries.id,
      customerId: waitlistEntries.customerId,
      phone: customers.phone,
    })
    .from(waitlistEntries)
    .innerJoin(customers, eq(customers.id, waitlistEntries.customerId))
    .where(
      and(
        eq(waitlistEntries.tenantId, tenantId),
        eq(waitlistEntries.status, 'waiting'),
        isNotNull(customers.phone),
        or(
          isNull(waitlistEntries.missedWindowStartsAt),
          ne(waitlistEntries.missedWindowStartsAt, startsAt),
        ),
      ),
    )
    .orderBy(desc(waitlistEntries.priority), asc(waitlistEntries.createdAt))
    .limit(1)
    .for('update', { of: waitlistEntries, skipLocked: true })
  return entry as { id: string; customerId: string; phone: string } | undefined
}

export async function setOffer(
  tenantId: string,
  entryId: string,
  offer: {
    offerWindowId: string
    offerDate: string
    offerWindowStartsAt: Date
    offerExpiresAt: Date
    offerLinkHash: string
  },
  tx: Db,
) {
  await tx
    .update(waitlistEntries)
    .set({ status: 'offered', offeredAt: new Date(), ...offer })
    .where(and(eq(waitlistEntries.tenantId, tenantId), eq(waitlistEntries.id, entryId)))
}
```

`.for('update', { of: waitlistEntries, skipLocked: true })`: if the Drizzle version complains
about this form, use `.for('update', { of: waitlistEntries, skipLocked: true } as const)` or
check `node_modules/drizzle-orm/pg-core/query-builders/select.d.ts` for the option names.

- [ ] **Step 4: Write the job**

Create `relay-api/src/modules/online-booking/waitlist.service.ts`:

```ts
import { db } from '../../db/client.ts'
import { WAITLIST_OFFER_MINUTES } from '../../db/schema.ts'
import { formatDay, textWindow } from '../../lib/labels.ts'
import { newLinkToken } from '../../lib/link-token.ts'
import { tenantUrl } from '../../lib/tenant-url.ts'
import * as booking from '../booking/booking.queries.ts'
import { quietUntil } from '../messaging/rules.ts'
import { sendText } from '../messaging/sms.ts'
import { offerText, takenOffText } from './waitlist-texts.ts'
import * as queries from './waitlist.queries.ts'

// The waitlist's side of booking: when a place opens, the next homeowner in line gets a text
// with a link that books it, and the place is held for them for 30 minutes.

const DAYS_AHEAD = 14 // the booking calendar's two weeks
const LEAD_MINUTES = 120 // a technician needs time to get there

type OfferingTenant = Awaited<ReturnType<typeof queries.listTenantsToOffer>>[number]
type Place = Awaited<ReturnType<typeof queries.listOpenPlaces>>[number]

// Run every minute by the 'waitlist-offers' job. Finds openings from the current state, so it
// covers every way a place frees up: a cancel, a move, a bigger window. Returns how many offers
// it made and how many ran out.
export async function sendWaitlistOffers() {
  await queries.closeFinishedEntries()
  const expired = await lapseOffers()
  let offered = 0
  for (const tenant of await queries.listTenantsToOffer()) {
    // An offer at night would run out before anyone reads it.
    if (quietUntil(new Date(), tenant.timezone, tenant.quietHoursStart, tenant.quietHoursEnd)) {
      continue
    }
    offered += await offerOpenPlaces(tenant)
  }
  return { offered, expired }
}

// Offers that ran out, and the last text for those taken off, together.
function lapseOffers() {
  return db.transaction(async (tx) => {
    const lapsed = await queries.lapseOffers(tx)
    const takenOff = lapsed.filter((entry) => entry.status === 'expired').map((entry) => entry.id)
    for (const entry of await queries.listTakenOff(takenOff, tx)) {
      await sendText(
        entry.tenantId,
        {
          contact: entry.phone!,
          kind: 'waitlist_offer',
          customerId: entry.customerId,
          body: takenOffText({ tenantName: entry.tenantName, link: tenantUrl(entry, '/') }),
        },
        tx,
      )
    }
    return lapsed.length
  })
}

async function offerOpenPlaces(tenant: OfferingTenant) {
  let offered = 0
  for (const place of await queries.listOpenPlaces(tenant.id, DAYS_AHEAD, LEAD_MINUTES)) {
    for (let i = 0; i < place.free; i++) {
      // Nobody waiting for this place (everyone left just missed it), or it filled: try the
      // next one.
      if ((await offerPlace(tenant, place)) !== 'offered') break
      offered++
    }
  }
  return offered
}

// One place to one homeowner, with its text. The window is locked as for a booking, so a
// booking at the same moment can't take the place too.
function offerPlace(tenant: OfferingTenant, place: Place) {
  return db.transaction(async (tx): Promise<'offered' | 'full' | 'nobody_waiting'> => {
    const window = await booking.lockWindow(tenant.id, place.windowId, place.date, tx)
    if (!window) return 'full'
    const taken =
      (await booking.countActiveJobsAt(tenant.id, place.windowStartsAt, undefined, tx)) +
      (await booking.countOpenOffersAt(tenant.id, place.windowStartsAt, undefined, tx))
    if (taken >= window.jobCap) return 'full'

    const entry = await queries.lockNextWaiting(tenant.id, place.windowStartsAt, tx)
    if (!entry) return 'nobody_waiting'
    const link = newLinkToken()
    await queries.setOffer(
      tenant.id,
      entry.id,
      {
        offerWindowId: place.windowId,
        offerDate: place.date,
        offerWindowStartsAt: place.windowStartsAt,
        offerExpiresAt: new Date(Date.now() + WAITLIST_OFFER_MINUTES * 60_000),
        offerLinkHash: link.hash,
      },
      tx,
    )
    await sendText(
      tenant.id,
      {
        contact: entry.phone,
        kind: 'waitlist_offer',
        customerId: entry.customerId,
        body: offerText({
          tenantName: tenant.name,
          dayLabel: formatDay(place.date),
          windowLabel: textWindow(place.windowStartsAt, place.windowEndsAt, tenant.timezone),
          link: tenantUrl(tenant, `/?offer=${link.token}`),
        }),
      },
      tx,
    )
    return 'offered'
  })
}
```

`'nobody_waiting'` moves on to the next place instead of stopping: a homeowner who just missed
this place may still take a later one (the "takes the homeowner off after 2" test needs this).

- [ ] **Step 5: Register the job**

In `relay-api/src/jobs/index.ts`, import
`import * as waitlist from '../modules/online-booking/waitlist.service.ts'` and add after the
`booking-recovery` registration:

```ts
  // Every minute: a place that opened goes to the next homeowner on the waitlist.
  await register('waitlist-offers', { cron: '* * * * *' }, async () => {
    const { offered, expired } = await waitlist.sendWaitlistOffers()
    if (offered > 0 || expired > 0) logger.info({ offered, expired }, 'Waitlist offers made')
  })
```

- [ ] **Step 6: Run the tests to check they pass**

Run: `npx vitest run src/modules/online-booking/waitlist.test.ts`
Expected: PASS. If "takes the homeowner off after 2" fails on the second run's `offered: 0`, the
missed place went straight back to the same homeowner. Check `lapseOffers` sets
`missedWindowStartsAt` from the old `offer_window_starts_at`.

- [ ] **Step 7: Commit**

```bash
git add src/modules/online-booking/waitlist.queries.ts src/modules/online-booking/waitlist.service.ts src/modules/online-booking/waitlist.test.ts src/jobs/index.ts
git commit -m "feat: waitlist-offers job texts the next homeowner when a place opens

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Joining again keeps one entry

**Files:**
- Modify: `relay-api/src/modules/online-booking/waitlist.queries.ts`
- Modify: `relay-api/src/modules/online-booking/online-booking.service.ts:215-242` (`joinWaitlist`)
- Test: `relay-api/src/modules/online-booking/waitlist.test.ts`

**Interfaces:**
- Produces: `renewOpenEntry(tenantId, customerId, serviceId, values: { zip: string; priority: boolean }, tx): Promise<boolean>` (true when an open entry was renewed).

- [ ] **Step 1: Write the failing tests**

Append to `waitlist.test.ts`:

```ts
describe('joining again', () => {
  it('keeps one entry and its place in line, and restarts the 14 days', async () => {
    const shop = await createWaitlistShop()
    await join(shop, { name: 'Ann Early', phone: '(480) 555-0101' })
    await db.update(waitlistEntries).set({ endsAt: new Date(Date.now() + 86_400_000) })
    const [before] = await entries()

    await join(shop, { name: 'Ann Early', phone: '(480) 555-0101', vulnerableOccupant: true })

    const all = await entries()
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({ id: before.id, createdAt: before.createdAt, priority: true })
    expect(all[0].endsAt.getTime()).toBeGreaterThan(Date.now() + 13 * 86_400_000)
  })

  it('adds a new entry once the old one is finished', async () => {
    const shop = await createWaitlistShop()
    await join(shop, { name: 'Ann Early', phone: '(480) 555-0101' })
    await db.update(waitlistEntries).set({ status: 'expired' })

    await join(shop, { name: 'Ann Early', phone: '(480) 555-0101' })

    expect((await entries()).map((entry) => entry.status)).toEqual(['expired', 'waiting'])
  })
})
```

- [ ] **Step 2: Run them to check they fail**

Run: `npx vitest run src/modules/online-booking/waitlist.test.ts -t "joining again"`
Expected: the first FAILS (2 entries); the second PASSES.

- [ ] **Step 3: Renew instead of adding**

Append to `waitlist.queries.ts`:

```ts
// A homeowner joining again for the same service: their open entry gets the new answers and 14
// more days, and keeps its place in line. False when they have no open entry.
export async function renewOpenEntry(
  tenantId: string,
  customerId: string,
  serviceId: string,
  values: { zip: string; priority: boolean },
  tx: Db,
) {
  const renewed = await tx
    .update(waitlistEntries)
    .set({ ...values, endsAt: sql`now() + interval '14 days'` })
    .where(
      and(
        eq(waitlistEntries.tenantId, tenantId),
        eq(waitlistEntries.customerId, customerId),
        eq(waitlistEntries.serviceId, serviceId),
        inArray(waitlistEntries.status, OPEN),
      ),
    )
    .returning({ id: waitlistEntries.id })
  return renewed.length > 0
}
```

In `online-booking.service.ts`, import `* as waitlist from './waitlist.queries.ts'` and change
the insert in `joinWaitlist`:

```ts
    const customer = await findOrAddCustomer(tenantId, input, tx)
    const values = { zip: input.zip, priority: input.vulnerableOccupant }
    if (!(await waitlist.renewOpenEntry(tenantId, customer.id, input.serviceId, values, tx))) {
      await queries.insertWaitlistEntry(
        tenantId,
        { customerId: customer.id, serviceId: input.serviceId, ...values },
        tx,
      )
    }
```

(The consent row below it is unchanged.)

- [ ] **Step 4: Run the tests to check they pass**

Run: `npx vitest run src/modules/online-booking`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/online-booking
git commit -m "feat: joining the waitlist again keeps one entry

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Booking from the offer link (API)

**Files:**
- Modify: `relay-api/src/modules/online-booking/waitlist.queries.ts`
- Modify: `relay-api/src/modules/online-booking/waitlist.service.ts`
- Modify: `relay-api/src/modules/online-booking/online-booking.schemas.ts:54-72` (`BookingInput`)
- Modify: `relay-api/src/modules/online-booking/online-booking.service.ts` (`listOpenWindows`, `bookVisit`)
- Modify: `relay-api/src/modules/online-booking/online-booking.routes.ts:52-55` and after `/bookings`
- Test: `relay-api/src/modules/online-booking/waitlist.test.ts`

**Interfaces:**
- Consumes: `reserveOpenWindow(..., excludeJobId?, excludeOfferId?)` and
  `listOpenWindows(tenantId, days, offerId?)` (Task 2).
- Produces:
  - `GET /api/online-booking/offers/:token` → `{ serviceId, zip, name, phone, vulnerableOccupant, date, windowId, dayLabel, windowLabel, heldUntilLabel }` (all strings except `vulnerableOccupant: boolean`), or a 404.
  - `GET /api/online-booking/windows?offer=<token>`
  - `BookingInput.offerToken?: string`
  - `getOffer(tenant: Tenant, token: string)`, `findOpenOfferId(tenantId: string, token: string | undefined, tx?: Db): Promise<string | undefined>` in `waitlist.service.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `waitlist.test.ts`:

```ts
// Ann on the waitlist with an open offer for `soon` (`later` is taken). Returns her link token.
async function offerToAnn(shop: WaitlistShop) {
  await join(shop, { name: 'Ann Early', phone: '(480) 555-0101' })
  await fillPlace(shop, shop.later)
  await sendWaitlistOffers()
  const [text] = await offerTexts()
  return tokenIn(text.body)
}

const ANN = { name: 'Ann Early', phone: '(480) 555-0101' }

describe('GET /api/online-booking/offers/:token', () => {
  it('shows the offer on its own link', async () => {
    const shop = await createWaitlistShop()
    const token = await offerToAnn(shop)

    const res = await get(`offers/${token}`).expect(200)
    expect(res.body).toEqual({
      serviceId: shop.service.id,
      zip: '85201',
      name: 'Ann Early',
      phone: '+14805550101',
      vulnerableOccupant: false,
      date: shop.soon,
      windowId: shop.window.id,
      dayLabel: expect.stringMatching(/^\w{3}, \w{3} \d{1,2}$/),
      windowLabel: '8 AM–12 PM',
      heldUntilLabel: expect.stringMatching(/^\d{1,2}(:\d{2})? (AM|PM)$/),
    })
  })

  it('says the offer ended once it ran out', async () => {
    const shop = await createWaitlistShop()
    const token = await offerToAnn(shop)
    await runOut()

    const res = await get(`offers/${token}`).expect(404)
    expect(res.body.error.message).toBe(
      'This offer has ended. Pick another time, or call (480) 555-0100.',
    )
  })

  it('works only on its own contractor’s address', async () => {
    const shop = await createWaitlistShop()
    const token = await offerToAnn(shop)
    await createShop('other')

    await get(`offers/${token}`, 'other').expect(404)
  })

  it('says the offer ended when the office deleted its window', async () => {
    const shop = await createWaitlistShop()
    const token = await offerToAnn(shop)
    await db.delete(arrivalWindows).where(eq(arrivalWindows.id, shop.window.id))

    await get(`offers/${token}`).expect(404)
  })
})

describe('booking from an offer', () => {
  it('lets the holder book the held place, and closes their entry', async () => {
    const shop = await createWaitlistShop()
    const token = await offerToAnn(shop)

    await post('bookings', bookingBody(shop, { ...ANN, offerToken: token })).expect(201)

    const [ann] = await entries()
    expect(ann).toMatchObject({ status: 'booked', offerLinkHash: null })
    await get(`offers/${token}`).expect(404)
  })

  it('shows the held place on the holder’s calendar only', async () => {
    const shop = await createWaitlistShop()
    const token = await offerToAnn(shop)
    const dates = (res: request.Response) =>
      res.body.days.map((day: { date: string }) => day.date)

    expect(dates(await get(`windows?offer=${token}`).expect(200))).toEqual([shop.soon])
    expect(dates(await get('windows').expect(200))).toEqual([])
  })

  it('books with an ended offer when the place is still free', async () => {
    const shop = await createWaitlistShop()
    const token = await offerToAnn(shop)
    await runOut()

    await post('bookings', bookingBody(shop, { ...ANN, offerToken: token })).expect(201)
  })

  it('ignores a made-up offer token: the place stays held', async () => {
    const shop = await createWaitlistShop()
    await offerToAnn(shop)

    const res = await post('bookings', bookingBody(shop, { offerToken: 'made-up-token' }))
      .expect(409)
    expect(res.body.error.code).toBe('window_full')
  })
})
```

`runOut` is defined in Task 4's block. Keep these new `describe`s below it in the file.

- [ ] **Step 2: Run them to check they fail**

Run: `npx vitest run src/modules/online-booking/waitlist.test.ts -t "offer"`
Expected: the `GET offers` tests FAIL with 404 (no route), and the holder's booking FAILS with
409. The made-up-token and ended-offer bookings may already PASS.

- [ ] **Step 3: Find an offer by its token**

Append to `waitlist.queries.ts` (add `arrivalWindows` and `gt` to the imports):

```ts
// An open offer by its link's hash, with what the booking page fills in. Nothing once it ran
// out, was used, or its window was deleted.
export async function findOpenOffer(tenantId: string, linkHash: string, tx: Db = db) {
  const [offer] = await tx
    .select({
      id: waitlistEntries.id,
      serviceId: waitlistEntries.serviceId,
      zip: waitlistEntries.zip,
      priority: waitlistEntries.priority,
      date: waitlistEntries.offerDate,
      windowId: waitlistEntries.offerWindowId,
      expiresAt: waitlistEntries.offerExpiresAt,
      name: customers.name,
      phone: customers.phone,
      startsAt: arrivalWindows.startsAt,
      endsAt: arrivalWindows.endsAt,
    })
    .from(waitlistEntries)
    .innerJoin(customers, eq(customers.id, waitlistEntries.customerId))
    .innerJoin(
      arrivalWindows,
      and(
        eq(arrivalWindows.tenantId, waitlistEntries.tenantId),
        eq(arrivalWindows.id, waitlistEntries.offerWindowId),
      ),
    )
    .where(
      and(
        eq(waitlistEntries.tenantId, tenantId),
        eq(waitlistEntries.offerLinkHash, linkHash),
        eq(waitlistEntries.status, 'offered'),
        gt(waitlistEntries.offerExpiresAt, sql`now()`),
      ),
    )
  return offer
}

// The homeowner booked from their offer.
export async function markOfferBooked(tenantId: string, entryId: string, tx: Db) {
  await tx
    .update(waitlistEntries)
    .set({ status: 'booked', ...NO_OFFER })
    .where(
      and(
        eq(waitlistEntries.tenantId, tenantId),
        eq(waitlistEntries.id, entryId),
        eq(waitlistEntries.status, 'offered'),
      ),
    )
}
```

Append to `waitlist.service.ts` (add imports: `type Db` from `../../db/client.ts`, `type Tenant`
from `../../db/schema.ts`, `HttpError` from `../../lib/http-error.ts`, `formatClock`,
`formatPhone`, `formatWindow` from `../../lib/labels.ts`, `hashLinkToken` from
`../../lib/link-token.ts`):

```ts
const offerEnded = (tenant: Tenant) =>
  new HttpError(
    404,
    'not_found',
    `This offer has ended. Pick another time, or call ${formatPhone(tenant.contactPhone)}.`,
  )

// The offer link: what the booking page fills in, and until when the place is held.
export async function getOffer(tenant: Tenant, token: string) {
  const offer = await queries.findOpenOffer(tenant.id, hashLinkToken(token))
  if (!offer) throw offerEnded(tenant)
  return {
    serviceId: offer.serviceId,
    zip: offer.zip,
    name: offer.name,
    phone: offer.phone ?? '',
    vulnerableOccupant: offer.priority,
    date: offer.date!,
    windowId: offer.windowId!,
    dayLabel: formatDay(offer.date!),
    windowLabel: formatWindow(offer.startsAt, offer.endsAt),
    heldUntilLabel: formatClock(offer.expiresAt!, tenant.timezone),
  }
}

// The open offer a token names, if any. An ended or unknown token is ignored: it must never
// stop a booking or the calendar.
export async function findOpenOfferId(tenantId: string, token: string | undefined, tx: Db = db) {
  if (!token) return undefined
  return (await queries.findOpenOffer(tenantId, hashLinkToken(token), tx))?.id
}
```

- [ ] **Step 4: Use the offer in the calendar and the booking**

In `online-booking.schemas.ts`, add to `BookingInput` after `draftToken`:

```ts
  offerToken: z.string().max(64).optional(), // the waitlist offer this booking takes
```

In `online-booking.service.ts`, import
`import * as waitlistOffers from './waitlist.service.ts'` (Task 5 already imported
`./waitlist.queries.ts` as `waitlist`). Then:

```ts
// Step 5: open arrival windows for the next two weeks, grouped by day. With a waitlist offer's
// token, the place held for that homeowner shows as open.
export async function listOpenWindows(tenantId: string, offerToken?: string) {
  const offerId = await waitlistOffers.findOpenOfferId(tenantId, offerToken)
  const rows = await queries.listOpenWindows(tenantId, DAYS_AHEAD, offerId)
```

(The rest of `listOpenWindows` is unchanged.) In `bookVisit`, replace the `reserveOpenWindow` line:

```ts
    // A place held for this homeowner from the waitlist doesn't count against them.
    const offerId = await waitlistOffers.findOpenOfferId(tenant.id, input.offerToken, tx)
    const slot = await reserveOpenWindow(
      tx,
      tenant.id,
      input.windowId,
      input.date,
      undefined,
      offerId,
    )
```

and after the draft block (`if (draft) await queries.markDraftBooked(...)`) add:

```ts
    if (offerId) await waitlist.markOfferBooked(tenant.id, offerId, tx)
```

- [ ] **Step 5: Add the routes**

In `online-booking.routes.ts`, import `* as waitlistOffers from './waitlist.service.ts'`.
Change the windows route to:

```ts
onlineBookingRoutes.get('/online-booking/windows', tenantFromHost, async (req, res) => {
  const offer = typeof req.query.offer === 'string' ? req.query.offer : undefined
  res.json(await onlineBooking.listOpenWindows(req.tenant!.id, offer))
})
```

(Keep whatever the current route has besides this, such as caching headers, as it is.) Add
after the `/online-booking/bookings` route:

```ts
// The link in a waitlist offer text: the place held for this homeowner.
onlineBookingRoutes.get(
  '/online-booking/offers/:token',
  formLimit,
  tenantFromHost,
  async (req, res) => {
    res.json(await waitlistOffers.getOffer(req.tenant!, String(req.params.token)))
  },
)
```

- [ ] **Step 6: Run all the API tests**

Run: `npm test`
Expected: PASS for everything. If the 4 branding tests fail as they did before (the test
database needs re-migrating), note it and check they fail on `feat/booking-manage-link` too.

- [ ] **Step 7: Lint, typecheck, commit**

```bash
npm run lint && npm run typecheck
git add src/modules/online-booking
git commit -m "feat: book the place a waitlist offer holds

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The offer link in the booking wizard (web)

**Files:**
- Modify: `relay-web/src/features/booking/api.ts`
- Modify: `relay-web/src/features/booking/steps.ts`
- Modify: `relay-web/src/features/booking/booking-flow.tsx`
- Modify: `relay-web/src/features/booking/time-step.tsx`
- Modify: `relay-web/src/features/booking/details-step.tsx`
- Test: `relay-web/src/features/booking/steps.test.ts`

**Interfaces:**
- Consumes: Task 6's `GET offers/:token`, `windows?offer=`, `offerToken`.
- Produces: `Offer` type and `useOffer(token: string)` (data `Offer | null`);
  `useOpenWindows(offerToken = '')`; `answersFromOffer(offer: Offer, serviceIds: string[]): Answers`.

- [ ] **Step 1: Create the branch**

```bash
cd ../relay-web
git switch feat/booking-manage-link
git switch -c feat/waitlist-offer
```

- [ ] **Step 2: Write the failing tests**

Add to `relay-web/src/features/booking/steps.test.ts` (extend the `./steps` import with
`answersFromOffer`, and add `import type { Offer } from './api'`):

```ts
const OFFER: Offer = {
  serviceId: 'service-1',
  zip: '85201',
  name: 'Ann Early',
  phone: '+14805550101',
  vulnerableOccupant: true,
  date: '2030-01-08',
  windowId: 'window-1',
  dayLabel: 'Tue, Jan 8',
  windowLabel: '8 AM–12 PM',
  heldUntilLabel: '3:42 PM',
}

it('starts an offer link at the problem step, with the held time already picked', () => {
  const answers = answersFromOffer(OFFER, ['service-1'])
  expect(answers).toEqual({
    ...NO_ANSWERS,
    serviceId: 'service-1',
    zip: '85201',
    name: 'Ann Early',
    phone: '+14805550101',
    vulnerableOccupant: true,
    date: '2030-01-08',
    windowId: 'window-1',
    timeLabel: 'Tue, Jan 8, 8 AM–12 PM',
  })
  expect(stepToShow('details', answers)).toBe('problem')
})

it('sends an offer for a service no longer offered back to step 1', () => {
  expect(stepToShow('details', answersFromOffer(OFFER, ['service-2']))).toBe('service')
})
```

- [ ] **Step 3: Run them to check they fail**

Run (in `relay-web`): `npx vitest run src/features/booking/steps.test.ts`
Expected: FAIL, `answersFromOffer` is not exported and `Offer` doesn't exist.

- [ ] **Step 4: The API calls**

In `api.ts`, add after `Draft`:

```ts
// A place offered from the waitlist (the `?offer=` link in the text), held for this homeowner.
const Offer = z.object({
  serviceId: z.string(),
  zip: z.string(),
  name: z.string(),
  phone: z.string(), // '+14805550101'
  vulnerableOccupant: z.boolean(),
  date: z.string(), // '2030-01-08'
  windowId: z.string(),
  dayLabel: z.string(), // 'Tue, Jan 8'
  windowLabel: z.string(), // '8 AM–12 PM'
  heldUntilLabel: z.string(), // '3:42 PM'
})
export type Offer = z.infer<typeof Offer>
```

Add `offerToken?: string // the waitlist offer this booking takes` to `BookingInput` after
`draftToken`.

Add after `useDraft`:

```ts
// On load: the waitlist offer the text's link names, or null when it has ended. Loaded once.
export function useOffer(token: string) {
  return useQuery({
    queryKey: ['online-booking', 'offer', token],
    enabled: token !== '',
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async () => {
      try {
        return await api.get(`/online-booking/offers/${encodeURIComponent(token)}`, Offer)
      } catch (error) {
        // Ended (404), or offline: either way the wizard starts as usual.
        if (!(error instanceof ApiError && error.status === 404)) {
          console.error('Loading the waitlist offer failed', error)
        }
        return null
      }
    },
  })
}
```

Replace `useOpenWindows`:

```ts
// Step 5: open arrival windows for the next two weeks, soonest first. With a waitlist offer's
// token, the place held for this homeowner is among them.
export function useOpenWindows(offerToken = '') {
  return useQuery({
    queryKey: [...windowsKey, offerToken],
    queryFn: () =>
      api.get(
        offerToken
          ? `/online-booking/windows?offer=${encodeURIComponent(offerToken)}`
          : '/online-booking/windows',
        OpenWindows,
      ),
    select: (data) => data.days,
  })
}
```

(`useBookVisit` still invalidates `windowsKey`, which matches both keys.)

- [ ] **Step 5: `answersFromOffer`**

In `steps.ts`, change the import to `import type { Draft, Offer } from './api'` and append:

```ts
// The wizard's starting answers for a homeowner opening a waitlist offer: who they are, what
// they need, and the held time already picked. A service the contractor stopped offering is
// dropped, so they pick one again.
export function answersFromOffer(offer: Offer, serviceIds: string[]): Answers {
  return {
    ...NO_ANSWERS,
    serviceId: serviceIds.includes(offer.serviceId) ? offer.serviceId : '',
    zip: offer.zip,
    name: offer.name,
    phone: offer.phone,
    vulnerableOccupant: offer.vulnerableOccupant,
    date: offer.date,
    windowId: offer.windowId,
    timeLabel: `${offer.dayLabel}, ${offer.windowLabel}`,
  }
}
```

- [ ] **Step 6: Run the tests to check they pass**

Run: `npx vitest run src/features/booking/steps.test.ts`
Expected: PASS.

- [ ] **Step 7: Read the offer link in the wizard**

In `booking-flow.tsx`:

1. Import `type Offer` and `useOffer` from `./api`, and `answersFromOffer` from `./steps`.
2. In `BookingFlow`, replace the token lines and the loading check:

```tsx
  // Read once: a waitlist offer's link (`?offer=`) wins over everything else. Otherwise the
  // link from a recovery text (`?resume=`), else the draft this browser kept.
  const [offerToken] = useState(() => params.get('offer') ?? '')
  const [resumeToken] = useState(() =>
    offerToken ? '' : (params.get('resume') ?? readDraftToken()),
  )
  const [fromTextLink] = useState(() => params.has('resume'))
  const options = useBookingOptions()
  const draft = useDraft(resumeToken)
  const offer = useOffer(offerToken)

  if (options.isPending || draft.isLoading || offer.isLoading) {
```

3. Pass the offer to the wizard:

```tsx
    <BookingWizard
      options={options.data}
      savedDraft={draft.data ?? null}
      savedToken={draft.data ? resumeToken : ''}
      fromTextLink={fromTextLink}
      offer={offer.data ? { ...offer.data, token: offerToken } : null}
      offerEnded={offerToken !== '' && !offer.data}
    />
```

4. In `BookingWizard`'s props, add `offer: (Offer & { token: string }) | null` and
   `offerEnded: boolean`, plus the matching destructured names. Change the starting answers and
   step:

```tsx
  const serviceIds = services.map((service) => service.id)
  const [answers, setAnswers] = useState<Answers>(() =>
    offer
      ? answersFromOffer(offer, serviceIds)
      : savedDraft
        ? answersFromDraft(savedDraft, serviceIds)
        : NO_ANSWERS,
  )
```

```tsx
  // A homeowner coming back has no `?step=` yet. From a text's link (a recovery text or a
  // waitlist offer), asking for the last step makes stepToShow pick the first one they haven't
  // answered; otherwise it's step 1.
  const step = stepToShow(
    params.get('step') ?? (offer || (savedDraft && fromTextLink) ? 'details' : null),
    answers,
  )
```

5. Show the banner right after `<BookingProgress … />`:

```tsx
      {offerEnded && (
        <Panel className="text-sm">This offer has ended, but you can still book a time.</Panel>
      )}
```

6. Pass the offer on:

```tsx
          <TimeStep
            answers={answers}
            waitlistConsentWording={waitlistConsentWording}
            offer={offer}
            onPick={(time) => go('details', time)}
          />
```

and add `offerToken={offer?.token ?? ''}` to `<DetailsStep … />`.

- [ ] **Step 8: The held note on the time step**

In `time-step.tsx`, import `type Offer` from `./api`, add the prop
`offer: (Offer & { token: string }) | null` to `TimeStep`, and change the windows call:

```tsx
  const days = useOpenWindows(offer?.token ?? '')
```

Show the note just above the Continue button:

```tsx
          {offer && picked?.date === offer.date && picked.windowId === offer.windowId && (
            <p className="rounded-2xl bg-primary/10 p-3 text-sm">
              Held for you until {offer.heldUntilLabel}.
            </p>
          )}
```

- [ ] **Step 9: Send the token with the booking**

In `details-step.tsx`, add the prop `offerToken: string` (with a line in the props comment: the
waitlist offer this booking takes, or ''), and in `book.mutate({ … })` add after `draftToken`:

```tsx
        offerToken: offerToken || undefined,
```

- [ ] **Step 10: Run tests, lint and typecheck**

Run (in `relay-web`): `npm test && npm run lint && npm run typecheck`
Expected: PASS, apart from the user's untracked `landing.test.ts` (4 failures that were there
before; leave it alone).

- [ ] **Step 11: Commit**

```bash
git add src/features/booking
git commit -m "feat: open a waitlist offer's link in the booking wizard

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Check in the browser, with the user

No code. Both apps run on `feat/waitlist-offer` (`npm run dev` in each; restart `relay-api` so
the new job is registered).

- [ ] Book `desert`'s calendar full for one window in the next few days, or lower that window's
  cap in settings so it's full.
- [ ] On `http://desert.localhost:5173`, go to the time step, click "None of these work for me",
  and join the waitlist with your own phone.
- [ ] Cancel one of the jobs in that window (dispatch board, or a manage link).
- [ ] Within a minute, the `relay-api` terminal (or the phone, with `SMS_PROVIDER` set to
  real texting) shows the offer text with a `/?offer=…` link.
- [ ] Open the link on `http://desert.localhost:5173/?offer=…` (add the port). The wizard opens
  at "What's going on?" with your name and phone filled in.
- [ ] On the time step, the offered window is picked with "Held for you until …".
- [ ] In a private window, open the booking page: the held window isn't offered.
- [ ] Book from the offer. The confirmation is sent. Opening the link again shows "This offer
  has ended, but you can still book a time."
- [ ] At phone width (375 px), the note and the banner don't overflow.
