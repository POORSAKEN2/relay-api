# Job Repairs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The office keeps a repair price list; the technician adds repairs from it to a job in progress; the homeowner approves or declines them on the technician's phone; every job also carries its booked lines (the service and the priority fee), so step 2's invoice is simply the approved lines.

**Architecture:** A new `charges` module owns `job_items` (booked lines, repairs, the decision, totals) and depends on no other module. `catalog` gains the price list next to services. Both ways of booking go through one `insertBookedJob()` in `booking.service.ts`, which writes the booked lines in the booking's transaction. `technician-jobs` and `dispatch` call `charges`; nothing calls back. A new live event `job.charges_changed` reloads the office drawer and the technician's pages.

**Tech Stack:** relay-api: Express 5, Drizzle ORM, PostgreSQL 18, Zod 4, Vitest + Supertest. relay-web: React 19, TanStack Query, Zod 4, Base UI dialogs (shadcn), sonner, Vitest.

**Spec:** `relay-api/docs/superpowers/specs/2026-10-02-job-repairs-design.md`

## Global Constraints

- Branch `feat/job-repairs` in both repos (already created from `main`; the spec is committed in relay-api).
- Architecture: one place per rule; module dependencies one-way (`booking`, `dispatch`, `technician-jobs` → `charges`; `technician-jobs` → `catalog`; `charges` imports no other module except `audit` and the realtime emitter); routes → service → queries; pure functions for wording and money with their own tests; reuse existing queries and helpers. Balance with lean code a junior developer can read top to bottom.
- No object property named `then`. Hooks on change functions are `checkJob`.
- Commit messages lowercase conventional (`feat: …`); no `Co-Authored-By` trailer. Biome only on touched files: `npx biome check --write <paths>`.
- Money is integer cents in the API; the web shows `formatMoney(cents)`: `$89`, `$89.50`, `$1,234.50`.
- Booked line descriptions: fixed `<service name>`; diagnostic `<service name> (diagnostic fee)`; free `<service name> (free)` at 0; priority `Priority service`. Booked lines are `approved`, `price_item_id` null, quantity 1.
- Line order: service line, then `Priority service`, then repairs by when they were added.
- Repairs: from the price list only; quantity 1–20; added as `proposed`; only while the job is `in_progress`.
- Exact copy:
  - Price item name: `Enter a name`, `Keep the name to 100 characters or fewer`; price: `Enter a price from $0 to $10,000`; unknown/other contractor's: `That price isn’t on your list.`
  - Not in progress: `Start the job before adding repairs.`; archived/unknown price: `That price isn’t on the list anymore.`; bad quantity: `Pick a quantity from 1 to 20`; bad price item id: `Pick a repair from the list`; bad decision: `Pick approve or decline`
  - Removing a non-waiting line: `Only repairs waiting for the homeowner can be removed.`; unknown line: `That repair isn’t on this job.`
  - Nothing to decide: `There are no repairs waiting for the homeowner.`
  - Not yours: `This job isn’t assigned to you anymore.`
  - Web: section `Charges`; `Approved so far: <money>`; buttons `Add repair`, `Review with homeowner`; review sheet `Total if approved: <money>`, `Approve <money>`, `Decline repairs`, `Not now`; office section `Repair prices`, button `Add repair price`; network failure `Couldn’t update the job. Check your connection and try again.`
- Audit actions: `job.repair_proposed` `{ itemId, description, quantity, unitPriceCents }`, `job.repair_removed` `{ itemId }`, `job.repairs_approved` / `job.repairs_declined` `{ itemIds, totalCents, how: 'in_person' }`, `price_item.added`, `price_item.updated`, `price_item.archived`, `price_item.restored`.

## Files

relay-api:
- Create `src/modules/charges/charges.queries.ts`, `charges.service.ts`, `charges.test.ts`.
- Modify `src/modules/booking/booking.service.ts` (`insertBookedJob`), `src/modules/online-booking/online-booking.service.ts` (use it).
- Create `drizzle/0008_job_booked_lines.sql` (custom migration).
- Modify `src/db/seed-dispatch.ts` (price list, booked lines for seeded jobs).
- Modify `src/modules/catalog/catalog.{schemas,queries,service,routes}.ts`; create `src/modules/catalog/price-items.test.ts`.
- Modify `src/realtime/events.ts` (`job.charges_changed`).
- Modify `src/modules/technician-jobs/technician-jobs.{schemas,service,routes}.ts`; create `src/modules/technician-jobs/repairs.test.ts`.
- Modify `src/modules/dispatch/dispatch.service.ts` (`charges` in the drawer) and `dispatch.test.ts`.

relay-web:
- Modify `src/lib/format.ts` + `format.test.ts` (`formatMoney`), `src/features/catalog/prices.ts` (use it).
- Modify `src/features/catalog/api.ts`; create `src/features/catalog/repair-prices.tsx`, `price-item-dialog.tsx`; modify `src/routes/services.tsx`.
- Create `src/features/charges/api.ts` (shared `Charges` schema), `src/features/charges/charge-lines.tsx`.
- Modify `src/lib/socket.ts` (event type), `src/features/dispatch/api.ts`, `job-drawer.tsx`.
- Modify `src/features/technician-jobs/api.ts`, `job-details.tsx`; create `job-charges.tsx`.

---

### Task 1: API — the `charges` module and booked lines on every job

**Files:**
- Create: `relay-api/src/modules/charges/charges.queries.ts`
- Create: `relay-api/src/modules/charges/charges.service.ts`
- Test: `relay-api/src/modules/charges/charges.test.ts` (pure functions)
- Test: `relay-api/src/modules/booking/booking.test.ts`, `relay-api/src/modules/online-booking/online-booking.test.ts` (booked lines through each way of booking)
- Modify: `relay-api/src/modules/booking/booking.service.ts` (import; new `insertBookedJob`; `bookForOffice` uses it)
- Modify: `relay-api/src/modules/online-booking/online-booking.service.ts` (`bookVisit` uses it)
- Create: `relay-api/drizzle/0008_job_booked_lines.sql` (custom migration)
- Modify: `relay-api/src/db/seed-dispatch.ts` (booked lines for seeded jobs)

**Interfaces:**
- Produces:
  - `charges.queries`: `PRIORITY_LINE = 'Priority service'`, `findBookedLineSource(tenantId, jobId, tx)`, `insertLines(tenantId, lines, tx)`, `listLines(tenantId, jobId, tx?)`
  - `charges.service`: `serviceLineDescription(name: string, priceType: 'fixed' | 'diagnostic' | 'free'): string`; `addBookedLines(tenantId: string, jobId: string, tx: Db): Promise<void>`; `summarize(rows)`; `getCharges(tenantId: string, jobId: string): Promise<Charges>` where `Charges = { lines: { id, description, quantity, unitPriceCents, totalCents, status, removable }[], approvedTotalCents: number, proposedTotalCents: number }`
  - `booking.service`: `insertBookedJob(tenantId: string, values: Parameters<typeof queries.insertJob>[1], tx: Tx)` → `{ id, priority }`

- [ ] **Step 1: Write the failing tests**

Create `relay-api/src/modules/charges/charges.test.ts` (no database: pure functions):

```ts
import { describe, expect, it } from 'vitest'
import { serviceLineDescription, summarize } from './charges.service.ts'

describe('serviceLineDescription', () => {
  it('names the booked service line by how the service is priced', () => {
    expect(serviceLineDescription('Tune-up', 'fixed')).toBe('Tune-up')
    expect(serviceLineDescription('AC repair', 'diagnostic')).toBe('AC repair (diagnostic fee)')
    expect(serviceLineDescription('New-system estimate', 'free')).toBe('New-system estimate (free)')
  })
})

describe('summarize', () => {
  it('adds up approved and waiting lines, and only waiting repairs can come off', () => {
    const line = (id: string, description: string, quantity: number, unitPriceCents: number) => ({
      id,
      description,
      quantity,
      unitPriceCents,
    })
    const rows = [
      { ...line('a', 'AC repair (diagnostic fee)', 1, 8900), status: 'approved' as const },
      { ...line('b', 'Capacitor replacement', 2, 18500), status: 'proposed' as const },
      { ...line('c', 'Contactor replacement', 1, 16500), status: 'declined' as const },
    ]

    expect(summarize(rows)).toEqual({
      lines: [
        { ...rows[0], totalCents: 8900, removable: false },
        { ...rows[1], totalCents: 37000, removable: true },
        { ...rows[2], totalCents: 16500, removable: false },
      ],
      approvedTotalCents: 8900,
      proposedTotalCents: 37000,
    })
  })
})
```

In `relay-api/src/modules/booking/booking.test.ts`, add `jobItems` to the `../../db/schema.ts` import and add inside `describe('POST /api/bookings', …)`:

```ts
  it('writes the booked service line at the price it was booked at', async () => {
    const shop = await createShop('desert')

    const res = await book(shop, newCustomerBooking(shop)).expect(201)
    // A later price change doesn't touch the job.
    await db.update(services).set({ priceCents: 9900 }).where(eq(services.id, shop.service.id))

    const lines = await db.select().from(jobItems).where(eq(jobItems.jobId, res.body.jobId))
    expect(lines).toEqual([
      expect.objectContaining({
        description: 'AC repair (diagnostic fee)',
        quantity: 1,
        unitPriceCents: 8900,
        status: 'approved',
        priceItemId: null,
      }),
    ])
  })

  it('writes a free service line at $0', async () => {
    const shop = await createShop('desert')
    const [estimate] = await db
      .insert(services)
      .values({
        tenantId: shop.tenant.id,
        name: 'New-system estimate',
        priceType: 'free',
        priceCents: 0,
      })
      .returning()

    const res = await book(shop, newCustomerBooking(shop, { serviceId: estimate.id })).expect(201)

    const lines = await db.select().from(jobItems).where(eq(jobItems.jobId, res.body.jobId))
    expect(lines).toEqual([
      expect.objectContaining({ description: 'New-system estimate (free)', unitPriceCents: 0 }),
    ])
  })
```

In `relay-api/src/modules/online-booking/online-booking.test.ts`, add `jobItems` to the `../../db/schema.ts` import and add inside `describe('POST /api/online-booking/bookings', …)`, after the priority fee tests:

```ts
  it('writes the booked lines: the service, and priority service when chosen', async () => {
    const shop = await createServingShop()
    await setPriorityFee(shop, 4900)

    const res = await post('bookings', bookingBody(shop, { priorityService: true })).expect(201)

    const lines = await db
      .select({
        description: jobItems.description,
        unitPriceCents: jobItems.unitPriceCents,
        status: jobItems.status,
      })
      .from(jobItems)
      .where(eq(jobItems.jobId, res.body.jobId))
      .orderBy(jobItems.description)
    expect(lines).toEqual([
      { description: 'AC repair (diagnostic fee)', unitPriceCents: 8900, status: 'approved' },
      { description: 'Priority service', unitPriceCents: 4900, status: 'approved' },
    ])
  })
```

- [ ] **Step 2: Run them to verify they fail**

Run (in `relay-api`): `npx vitest run src/modules/charges src/modules/booking src/modules/online-booking`
Expected: FAIL. `charges.test.ts` can't find `./charges.service.ts`; the three booking tests find no lines (`[]`).

- [ ] **Step 3: Add the charges queries**

Create `relay-api/src/modules/charges/charges.queries.ts`:

```ts
import { and, asc, eq, sql } from 'drizzle-orm'
import { type Db, db } from '../../db/client.ts'
import { jobItems, jobs, services } from '../../db/schema.ts'

// Tenant-scoped: every query takes tenantId first. This module owns job_items and reads the
// few other columns it needs itself, so it depends on no other module.

export const PRIORITY_LINE = 'Priority service'

// What a job's booked lines are made from: its service and the priority fee it was booked with.
export async function findBookedLineSource(tenantId: string, jobId: string, tx: Db) {
  const [source] = await tx
    .select({
      serviceName: services.name,
      priceType: services.priceType,
      priceCents: services.priceCents,
      priorityFeeCents: jobs.priorityFeeCents,
    })
    .from(jobs)
    .innerJoin(services, and(eq(services.tenantId, jobs.tenantId), eq(services.id, jobs.serviceId)))
    .where(and(eq(jobs.tenantId, tenantId), eq(jobs.id, jobId)))
  return source
}

type LineValues = Omit<typeof jobItems.$inferInsert, 'id' | 'tenantId' | 'createdAt'>

export function insertLines(tenantId: string, lines: LineValues[], tx: Db) {
  return tx
    .insert(jobItems)
    .values(lines.map((line) => ({ ...line, tenantId })))
    .returning({ id: jobItems.id })
}

// A job's lines: the service line, then priority service, then repairs as they were added.
// Booked lines are written together, so their order is spelled out rather than taken from time.
export function listLines(tenantId: string, jobId: string, tx: Db = db) {
  return tx
    .select({
      id: jobItems.id,
      description: jobItems.description,
      quantity: jobItems.quantity,
      unitPriceCents: jobItems.unitPriceCents,
      status: jobItems.status,
    })
    .from(jobItems)
    .where(and(eq(jobItems.tenantId, tenantId), eq(jobItems.jobId, jobId)))
    .orderBy(
      sql`${jobItems.priceItemId} is not null`,
      sql`${jobItems.description} = ${PRIORITY_LINE}`,
      asc(jobItems.createdAt),
      asc(jobItems.id),
    )
}
```

- [ ] **Step 4: Add the charges service**

Create `relay-api/src/modules/charges/charges.service.ts`:

```ts
import type { Db } from '../../db/client.ts'
import type { PRICE_TYPES } from '../../db/schema.ts'
import * as queries from './charges.queries.ts'

// A job's charges: the booked lines (the service, and priority service when chosen) and the
// repairs a technician adds from the price list, which the homeowner approves or declines.
// The invoice (part 5, step 2) is the approved lines.

// The booked service's line, named by how the service is priced.
export function serviceLineDescription(
  name: string,
  priceType: (typeof PRICE_TYPES)[number],
): string {
  if (priceType === 'diagnostic') return `${name} (diagnostic fee)`
  if (priceType === 'free') return `${name} (free)`
  return name
}

// Writes a newly booked job's lines, in the booking's transaction. Prices are frozen here.
export async function addBookedLines(tenantId: string, jobId: string, tx: Db) {
  const source = await queries.findBookedLineSource(tenantId, jobId, tx)
  const booked = { jobId, quantity: 1, status: 'approved' as const }
  const lines = [
    {
      ...booked,
      description: serviceLineDescription(source.serviceName, source.priceType),
      unitPriceCents: source.priceType === 'free' ? 0 : source.priceCents,
    },
  ]
  if (source.priorityFeeCents > 0) {
    lines.push({ ...booked, description: queries.PRIORITY_LINE, unitPriceCents: source.priorityFeeCents })
  }
  await queries.insertLines(tenantId, lines, tx)
}

type LineRow = Awaited<ReturnType<typeof queries.listLines>>[number]

// Each line's total and the two sums: what the homeowner agreed to, and what waits for them.
export function summarize(rows: LineRow[]) {
  const lines = rows.map((line) => ({
    ...line,
    totalCents: line.quantity * line.unitPriceCents,
    // Only a repair still waiting for the homeowner can come off the job. Booked lines are
    // approved from the start.
    removable: line.status === 'proposed',
  }))
  const sum = (status: LineRow['status']) =>
    lines.filter((line) => line.status === status).reduce((total, line) => total + line.totalCents, 0)
  return { lines, approvedTotalCents: sum('approved'), proposedTotalCents: sum('proposed') }
}

export async function getCharges(tenantId: string, jobId: string) {
  return summarize(await queries.listLines(tenantId, jobId))
}
```

- [ ] **Step 5: Book every job with its lines**

In `relay-api/src/modules/booking/booking.service.ts`, add the import:

```ts
import * as charges from '../charges/charges.service.ts'
```

add (above `tenantOf`):

```ts
// Books a job and writes its booked lines (the service, and priority service when chosen) in
// the same transaction. Every way of booking goes through here, so no job is without them.
export async function insertBookedJob(
  tenantId: string,
  values: Parameters<typeof queries.insertJob>[1],
  tx: Tx,
) {
  const job = await queries.insertJob(tenantId, values, tx)
  await charges.addBookedLines(tenantId, job.id, tx)
  return job
}
```

(`Tx` is already imported from `../../db/client.ts`), and in `bookForOffice` change `const job = await queries.insertJob(` to `const job = await insertBookedJob(`.

In `relay-api/src/modules/online-booking/online-booking.service.ts`, change the booking-service import to `import { insertBookedJob, reserveWindow } from '../booking/booking.service.ts'` and, in `bookVisit`, change `const job = await booking.insertJob(` to `const job = await insertBookedJob(`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/modules/charges src/modules/booking src/modules/online-booking`
Expected: PASS.

- [ ] **Step 7: Add the migration that gives existing jobs their lines**

Run (in `relay-api`): `npm run db:generate -- --custom --name job_booked_lines`
Expected: an empty `drizzle/0008_job_booked_lines.sql` and its journal entry.

Put this in `drizzle/0008_job_booked_lines.sql`:

```sql
-- Jobs booked before job lines existed get their booked lines, by the same rules as new
-- bookings (charges.service.ts addBookedLines), from each service's current price.
INSERT INTO "job_items" ("tenant_id", "job_id", "description", "quantity", "unit_price_cents", "status")
SELECT j."tenant_id", j."id",
  CASE s."price_type"
    WHEN 'diagnostic' THEN s."name" || ' (diagnostic fee)'
    WHEN 'free' THEN s."name" || ' (free)'
    ELSE s."name"
  END,
  1,
  CASE s."price_type" WHEN 'free' THEN 0 ELSE s."price_cents" END,
  'approved'
FROM "jobs" j
JOIN "services" s ON s."tenant_id" = j."tenant_id" AND s."id" = j."service_id"
WHERE NOT EXISTS (SELECT 1 FROM "job_items" i WHERE i."tenant_id" = j."tenant_id" AND i."job_id" = j."id");
--> statement-breakpoint
INSERT INTO "job_items" ("tenant_id", "job_id", "description", "quantity", "unit_price_cents", "status")
SELECT j."tenant_id", j."id", 'Priority service', 1, j."priority_fee_cents", 'approved'
FROM "jobs" j
WHERE j."priority_fee_cents" > 0
  AND NOT EXISTS (
    SELECT 1 FROM "job_items" i
    WHERE i."tenant_id" = j."tenant_id" AND i."job_id" = j."id" AND i."description" = 'Priority service'
  );
```

- [ ] **Step 8: Give seeded jobs their lines**

In `relay-api/src/db/seed-dispatch.ts`, add the import `import { addBookedLines } from '../modules/charges/charges.service.ts'` and, in the visit loop right after the `.returning()` of the job insert, add:

```ts
    await addBookedLines(tenantId, job.id, db)
```

- [ ] **Step 9: Run everything, migrate, check, commit**

```bash
npm test
npm run typecheck
npm run db:migrate
PGPASSWORD=relay "/c/Program Files/PostgreSQL/18/bin/psql" -U relay -d relay -tAc "select count(*) from jobs j where not exists (select 1 from job_items i where i.job_id = j.id)"
npx biome check --write src/modules/charges/charges.queries.ts src/modules/charges/charges.service.ts src/modules/charges/charges.test.ts src/modules/booking/booking.service.ts src/modules/booking/booking.test.ts src/modules/online-booking/online-booking.service.ts src/modules/online-booking/online-booking.test.ts src/db/seed-dispatch.ts
git add src/modules/charges src/modules/booking src/modules/online-booking src/db/seed-dispatch.ts drizzle
git commit -m "feat: give every job its booked lines"
```

Expected: all tests pass; typecheck prints nothing; the psql count prints `0` (every job has its booked lines).

---

### Task 2: API — the repair price list

**Files:**
- Modify: `relay-api/src/modules/catalog/catalog.schemas.ts`, `catalog.queries.ts`, `catalog.service.ts`, `catalog.routes.ts`
- Test: `relay-api/src/modules/catalog/price-items.test.ts`
- Modify: `relay-api/src/db/seed-dispatch.ts` (starter prices)

**Interfaces:**
- Produces:
  - Routes (staff): `GET /api/price-items` → `{ priceItems: { id, name, priceCents, archived }[] }`; `POST /api/price-items` `{ name, priceCents }` → `201 { priceItem }`; `PATCH /api/price-items/:priceItemId` → `{ priceItem }`; `POST /api/price-items/:priceItemId/archive|restore` → `{ priceItem }`
  - `catalog.service.listActivePriceItems(tenantId: string)` → `{ id, name, priceCents }[]` by name (for the technician's picker, Task 3)

- [ ] **Step 1: Write the failing tests**

Create `relay-api/src/modules/catalog/price-items.test.ts`:

```ts
import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createShop, resetDb, type Shop, signInTechnician } from '../../../test/helpers.ts'
import { createApp } from '../../app.ts'
import { db } from '../../db/client.ts'
import { auditEvents } from '../../db/schema.ts'

vi.mock('../../realtime/index.ts', () => ({ emitToTenant: vi.fn() }))

const app = createApp()

beforeEach(async () => {
  await resetDb()
})

function addPrice(shop: Shop, body: object) {
  return request(app).post('/api/price-items').set('Cookie', shop.cookie).send(body)
}

function listPrices(shop: Shop) {
  return request(app).get('/api/price-items').set('Cookie', shop.cookie).expect(200)
}

describe('repair prices', () => {
  it('adds, edits, archives and restores a price, active ones first by name', async () => {
    const shop = await createShop('desert')
    const contactor = (await addPrice(shop, { name: ' Contactor replacement ', priceCents: 16500 }).expect(201)).body.priceItem
    const capacitor = (await addPrice(shop, { name: 'Capacitor replacement', priceCents: 18500 }).expect(201)).body.priceItem
    expect(contactor).toEqual({ id: expect.any(String), name: 'Contactor replacement', priceCents: 16500, archived: false })

    await request(app)
      .patch(`/api/price-items/${capacitor.id}`)
      .set('Cookie', shop.cookie)
      .send({ name: 'Capacitor replacement', priceCents: 19500 })
      .expect(200)
    await request(app).post(`/api/price-items/${contactor.id}/archive`).set('Cookie', shop.cookie).expect(200)

    const listed = (await listPrices(shop)).body.priceItems
    expect(listed.map((item: { name: string; priceCents: number; archived: boolean }) => [item.name, item.priceCents, item.archived])).toEqual([
      ['Capacitor replacement', 19500, false],
      ['Contactor replacement', 16500, true],
    ])

    const restored = await request(app).post(`/api/price-items/${contactor.id}/restore`).set('Cookie', shop.cookie).expect(200)
    expect(restored.body.priceItem.archived).toBe(false)

    const events = await db.select().from(auditEvents).orderBy(auditEvents.createdAt)
    const actions = events.map((event) => event.action)
    expect(actions).toEqual(['price_item.added', 'price_item.added', 'price_item.updated', 'price_item.archived', 'price_item.restored'])
  })

  it('explains a bad name or price', async () => {
    const shop = await createShop('desert')
    const empty = await addPrice(shop, { name: ' ', priceCents: -1 }).expect(400)
    expect(empty.body.error.details).toEqual({
      name: ['Enter a name'],
      priceCents: ['Enter a price from $0 to $10,000'],
    })
    const long = await addPrice(shop, { name: 'x'.repeat(101), priceCents: 1_000_001 }).expect(400)
    expect(long.body.error.details).toEqual({
      name: ['Keep the name to 100 characters or fewer'],
      priceCents: ['Enter a price from $0 to $10,000'],
    })
    await addPrice(shop, { name: 'Free check', priceCents: 0 }).expect(201)
  })

  it("keeps each contractor's prices to themselves, and is for staff only", async () => {
    const shop = await createShop('desert')
    const other = await createShop('other')
    const theirs = (await addPrice(other, { name: 'Contactor', priceCents: 100 }).expect(201)).body.priceItem

    expect((await listPrices(shop)).body.priceItems).toEqual([])
    for (const id of [theirs.id, randomUUID()]) {
      const res = await request(app)
        .patch(`/api/price-items/${id}`)
        .set('Cookie', shop.cookie)
        .send({ name: 'Mine now', priceCents: 1 })
        .expect(404)
      expect(res.body.error.message).toBe('That price isn’t on your list.')
    }
    await request(app).get('/api/price-items').expect(401)
    await request(app).get('/api/price-items').set('Cookie', await signInTechnician(shop.mike)).expect(403)
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/modules/catalog/price-items.test.ts`
Expected: FAIL with `404` responses (no `/api/price-items` routes yet).

- [ ] **Step 3: Add the input schemas**

Append to `relay-api/src/modules/catalog/catalog.schemas.ts`:

```ts
const PRICE_MESSAGE = 'Enter a price from $0 to $10,000'

// Adding or editing a repair price. $0 is allowed (a free check); $10,000 is the most.
export const PriceItemInput = z.object({
  name: z
    .string('Enter a name')
    .trim()
    .min(1, 'Enter a name')
    .max(100, 'Keep the name to 100 characters or fewer'),
  priceCents: z
    .number(PRICE_MESSAGE)
    .int(PRICE_MESSAGE)
    .min(0, PRICE_MESSAGE)
    .max(1_000_000, PRICE_MESSAGE),
})
export type PriceItemInput = z.infer<typeof PriceItemInput>

export const PriceItemParams = z.object({
  priceItemId: z.uuid('That price isn’t on your list.'),
})
```

- [ ] **Step 4: Add the queries**

In `relay-api/src/modules/catalog/catalog.queries.ts`, add `priceItems` to the schema import, and append:

```ts
const priceColumns = {
  id: priceItems.id,
  name: priceItems.name,
  priceCents: priceItems.priceCents,
  archivedAt: priceItems.archivedAt,
}

const isPriceItemOf = (tenantId: string, priceItemId: string) =>
  and(eq(priceItems.tenantId, tenantId), eq(priceItems.id, priceItemId))

// Active prices first, then archived ones, each by name.
export function listPriceItems(tenantId: string) {
  return db
    .select(priceColumns)
    .from(priceItems)
    .where(eq(priceItems.tenantId, tenantId))
    .orderBy(sql`${priceItems.archivedAt} is not null`, asc(priceItems.name))
}

// What a technician can add to a job: active prices by name.
export function listActivePriceItems(tenantId: string) {
  return db
    .select({ id: priceItems.id, name: priceItems.name, priceCents: priceItems.priceCents })
    .from(priceItems)
    .where(and(eq(priceItems.tenantId, tenantId), isNull(priceItems.archivedAt)))
    .orderBy(asc(priceItems.name))
}

export async function findPriceItem(tenantId: string, priceItemId: string) {
  const [item] = await db.select(priceColumns).from(priceItems).where(isPriceItemOf(tenantId, priceItemId))
  return item
}

type PriceItemValues = Pick<typeof priceItems.$inferInsert, 'name' | 'priceCents'>

export async function insertPriceItem(tenantId: string, values: PriceItemValues) {
  const [item] = await db.insert(priceItems).values({ ...values, tenantId }).returning(priceColumns)
  return item
}

// Returns the price when it was found (and updated), undefined otherwise.
export async function updatePriceItem(tenantId: string, priceItemId: string, values: PriceItemValues) {
  const [item] = await db
    .update(priceItems)
    .set(values)
    .where(isPriceItemOf(tenantId, priceItemId))
    .returning(priceColumns)
  return item
}

// Returns the price only when this call archived it.
export async function archivePriceItem(tenantId: string, priceItemId: string) {
  const [item] = await db
    .update(priceItems)
    .set({ archivedAt: new Date() })
    .where(and(isPriceItemOf(tenantId, priceItemId), isNull(priceItems.archivedAt)))
    .returning(priceColumns)
  return item
}

// Returns the price only when this call restored it.
export async function restorePriceItem(tenantId: string, priceItemId: string) {
  const [item] = await db
    .update(priceItems)
    .set({ archivedAt: null })
    .where(and(isPriceItemOf(tenantId, priceItemId), isNotNull(priceItems.archivedAt)))
    .returning(priceColumns)
  return item
}
```

- [ ] **Step 5: Add the service functions**

In `relay-api/src/modules/catalog/catalog.service.ts`, change the schemas import to `import type { PriceItemInput, ServiceInput } from './catalog.schemas.ts'` and append:

```ts
// The repair price list. Technicians add these to a job; the homeowner approves the price.
// Prices are never deleted: archiving takes one off the technician's list and keeps it on
// jobs that used it.

const PRICE_NOT_ON_LIST = 'That price isn’t on your list.'

type PriceItemRow = NonNullable<Awaited<ReturnType<typeof queries.findPriceItem>>>

function toPriceItem({ archivedAt, ...row }: PriceItemRow) {
  return { ...row, archived: archivedAt !== null }
}

export async function listPriceItems(tenantId: string) {
  return (await queries.listPriceItems(tenantId)).map(toPriceItem)
}

export function listActivePriceItems(tenantId: string) {
  return queries.listActivePriceItems(tenantId)
}

export async function addPriceItem(user: SessionUser, input: PriceItemInput) {
  const item = await queries.insertPriceItem(tenantOf(user), input)
  await priceChanged(user, 'price_item.added', item.id)
  return toPriceItem(item)
}

export async function updatePriceItem(user: SessionUser, priceItemId: string, input: PriceItemInput) {
  const item = await queries.updatePriceItem(tenantOf(user), priceItemId, input)
  if (!item) throw new HttpError(404, 'not_found', PRICE_NOT_ON_LIST)
  await priceChanged(user, 'price_item.updated', priceItemId)
  return toPriceItem(item)
}

// Doing it twice is harmless.
export async function archivePriceItem(user: SessionUser, priceItemId: string) {
  const tenantId = tenantOf(user)
  const item = await queries.archivePriceItem(tenantId, priceItemId)
  if (!item) return foundPrice(await queries.findPriceItem(tenantId, priceItemId))
  await priceChanged(user, 'price_item.archived', priceItemId)
  return toPriceItem(item)
}

export async function restorePriceItem(user: SessionUser, priceItemId: string) {
  const tenantId = tenantOf(user)
  const item = await queries.restorePriceItem(tenantId, priceItemId)
  if (!item) return foundPrice(await queries.findPriceItem(tenantId, priceItemId))
  await priceChanged(user, 'price_item.restored', priceItemId)
  return toPriceItem(item)
}

async function priceChanged(user: SessionUser, action: string, priceItemId: string) {
  await audit.insertUserAction(tenantOf(user), {
    actorUserId: user.id,
    action,
    entityType: 'price_item',
    entityId: priceItemId,
  })
}

function foundPrice(row: PriceItemRow | undefined) {
  if (!row) throw new HttpError(404, 'not_found', PRICE_NOT_ON_LIST)
  return toPriceItem(row)
}
```

- [ ] **Step 6: Add the routes**

In `relay-api/src/modules/catalog/catalog.routes.ts`, change the schemas import to include `PriceItemInput, PriceItemParams`, and append:

```ts
// The repair price list, archived prices too. Technicians get only the active ones
// (GET /my-jobs/price-items).
catalogRoutes.get('/price-items', staff, async (req, res) => {
  res.json({ priceItems: await catalog.listPriceItems(tenantOf(req.user!)) })
})

catalogRoutes.post('/price-items', staff, async (req, res) => {
  const input = PriceItemInput.parse(req.body)
  res.status(201).json({ priceItem: await catalog.addPriceItem(req.user!, input) })
})

catalogRoutes.patch('/price-items/:priceItemId', staff, async (req, res) => {
  const { priceItemId } = PriceItemParams.parse(req.params)
  const input = PriceItemInput.parse(req.body)
  res.json({ priceItem: await catalog.updatePriceItem(req.user!, priceItemId, input) })
})

catalogRoutes.post('/price-items/:priceItemId/archive', staff, async (req, res) => {
  const { priceItemId } = PriceItemParams.parse(req.params)
  res.json({ priceItem: await catalog.archivePriceItem(req.user!, priceItemId) })
})

catalogRoutes.post('/price-items/:priceItemId/restore', staff, async (req, res) => {
  const { priceItemId } = PriceItemParams.parse(req.params)
  res.json({ priceItem: await catalog.restorePriceItem(req.user!, priceItemId) })
})
```

- [ ] **Step 7: Seed the starter prices**

In `relay-api/src/db/seed-dispatch.ts`, add `priceItems` to the schema import, add next to `SERVICES`:

```ts
// The demo contractor's repair price list.
const PRICE_ITEMS = [
  { name: 'Capacitor replacement', priceCents: 18500 },
  { name: 'Condenser fan motor', priceCents: 42500 },
  { name: 'Contactor replacement', priceCents: 16500 },
  { name: 'Drain line flush', priceCents: 12000 },
  { name: 'Refrigerant (per lb)', priceCents: 9500 },
  { name: 'Thermostat replacement', priceCents: 21000 },
]
```

and right after the services insert:

```ts
  await db.insert(priceItems).values(PRICE_ITEMS.map((item) => ({ ...item, tenantId })))
```

- [ ] **Step 8: Run the tests, typecheck, lint, commit**

```bash
npx vitest run src/modules/catalog
npm test
npm run typecheck
npx biome check --write src/modules/catalog/catalog.schemas.ts src/modules/catalog/catalog.queries.ts src/modules/catalog/catalog.service.ts src/modules/catalog/catalog.routes.ts src/modules/catalog/price-items.test.ts src/db/seed-dispatch.ts
git add src/modules/catalog src/db/seed-dispatch.ts
git commit -m "feat: add the repair price list"
```

Expected: PASS (3 new tests plus the existing catalog tests); typecheck prints nothing.

---

### Task 3: API — repairs on a job and the homeowner's decision

**Files:**
- Modify: `relay-api/src/modules/charges/charges.queries.ts`, `charges.service.ts`
- Modify: `relay-api/src/realtime/events.ts`
- Modify: `relay-api/src/modules/technician-jobs/technician-jobs.schemas.ts`, `technician-jobs.service.ts`, `technician-jobs.routes.ts`
- Modify: `relay-api/src/modules/dispatch/dispatch.service.ts` (`getJob`), `dispatch.test.ts`
- Test: `relay-api/src/modules/technician-jobs/repairs.test.ts`

**Interfaces:**
- Consumes: `getCharges`, `summarize` (Task 1); `catalog.listActivePriceItems` (Task 2); `findMyJob`, `getMyJob`, `notYours` (technician-jobs).
- Produces:
  - `charges.service`: `proposeRepair(actor, jobId, input, checkJob?)`, `removeRepair(actor, jobId, itemId, checkJob?)`, `decideRepairs(actor, jobId, decision, checkJob?)` where `actor = { tenantId: string; userId: string }`, `input = { priceItemId: string; quantity: number }`, `decision: 'approved' | 'declined'`, `checkJob?: (job: { technicianId: string | null }) => void`
  - Event `job.charges_changed` `{ jobId, dates }`
  - Routes: `GET /api/my-jobs/price-items`; `POST /api/my-jobs/:jobId/repairs`; `DELETE /api/my-jobs/:jobId/repairs/:itemId`; `POST /api/my-jobs/:jobId/repairs/decision`
  - `GET /api/my-jobs/:jobId` and `GET /api/jobs/:jobId` gain top-level `charges`

- [ ] **Step 1: Write the failing tests**

Create `relay-api/src/modules/technician-jobs/repairs.test.ts`:

```ts
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createJob,
  createShop,
  resetDb,
  type Shop,
  signInTechnician,
} from '../../../test/helpers.ts'
import { createApp } from '../../app.ts'
import { db } from '../../db/client.ts'
import { auditEvents, priceItems } from '../../db/schema.ts'
import { emitToTenant } from '../../realtime/index.ts'

vi.mock('../../realtime/index.ts', () => ({ emitToTenant: vi.fn() }))

const app = createApp()

beforeEach(async () => {
  await resetDb()
  vi.mocked(emitToTenant).mockClear()
})

// Today in Phoenix, where the test shop is: the technician's list shows today onwards.
function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Phoenix' }).format(new Date())
}

async function addPrice(shop: Shop, name: string, priceCents: number, archived = false) {
  const [item] = await db
    .insert(priceItems)
    .values({
      tenantId: shop.tenant.id,
      name,
      priceCents,
      archivedAt: archived ? new Date() : null,
    })
    .returning()
  return item
}

// One of Mike's jobs today, in progress, and his session.
async function mikesJob() {
  const shop = await createShop('desert')
  const job = await createJob(shop, {
    technicianId: shop.mike.id,
    at: `${today()} 08:00`,
    status: 'in_progress',
  })
  return { shop, job, cookie: await signInTechnician(shop.mike) }
}

function repairs(cookie: string, jobId: string) {
  return {
    add: (body: object) =>
      request(app).post(`/api/my-jobs/${jobId}/repairs`).set('Cookie', cookie).send(body),
    remove: (itemId: string) =>
      request(app).delete(`/api/my-jobs/${jobId}/repairs/${itemId}`).set('Cookie', cookie),
    decide: (decision: string) =>
      request(app)
        .post(`/api/my-jobs/${jobId}/repairs/decision`)
        .set('Cookie', cookie)
        .send({ decision }),
  }
}

describe('POST /api/my-jobs/:jobId/repairs', () => {
  it('adds a repair from the price list, waiting for the homeowner, at the listed price', async () => {
    const { shop, job, cookie } = await mikesJob()
    const capacitor = await addPrice(shop, 'Capacitor replacement', 18500)

    const res = await repairs(cookie, job.id)
      .add({ priceItemId: capacitor.id, quantity: 2 })
      .expect(200)

    expect(res.body.charges).toEqual({
      lines: [
        {
          id: expect.any(String),
          description: 'Capacitor replacement',
          quantity: 2,
          unitPriceCents: 18500,
          totalCents: 37000,
          status: 'proposed',
          removable: true,
        },
      ],
      approvedTotalCents: 0,
      proposedTotalCents: 37000,
    })
    // A later price change doesn't touch the job.
    await db.update(priceItems).set({ priceCents: 20000 }).where(eq(priceItems.id, capacitor.id))
    const page = await request(app).get(`/api/my-jobs/${job.id}`).set('Cookie', cookie).expect(200)
    expect(page.body.charges.lines[0].unitPriceCents).toBe(18500)

    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'job.repair_proposed'))
    expect(audit).toMatchObject({
      actorUserId: shop.mike.id,
      entityId: job.id,
      data: { description: 'Capacitor replacement', quantity: 2, unitPriceCents: 18500 },
    })
    expect(emitToTenant).toHaveBeenCalledWith(shop.tenant.id, 'job.charges_changed', {
      jobId: job.id,
      dates: [today()],
    })
  })

  it('needs the job in progress, a price on the list and a quantity from 1 to 20', async () => {
    const { shop, job, cookie } = await mikesJob()
    const price = await addPrice(shop, 'Contactor replacement', 16500)
    const archived = await addPrice(shop, 'Old part', 5000, true)
    const booked = await createJob(shop, {
      technicianId: shop.mike.id,
      at: `${today()} 12:00`,
      status: 'booked',
    })

    const notStarted = await repairs(cookie, booked.id)
      .add({ priceItemId: price.id, quantity: 1 })
      .expect(422)
    expect(notStarted.body.error.message).toBe('Start the job before adding repairs.')

    const gone = await repairs(cookie, job.id)
      .add({ priceItemId: archived.id, quantity: 1 })
      .expect(422)
    expect(gone.body.error.message).toBe('That price isn’t on the list anymore.')

    const tooMany = await repairs(cookie, job.id)
      .add({ priceItemId: price.id, quantity: 21 })
      .expect(400)
    expect(tooMany.body.error.details.quantity).toEqual(['Pick a quantity from 1 to 20'])
  })
})

describe('DELETE /api/my-jobs/:jobId/repairs/:itemId', () => {
  it('removes only repairs still waiting for the homeowner', async () => {
    const { shop, job, cookie } = await mikesJob()
    const price = await addPrice(shop, 'Drain line flush', 12000)
    const jobRepairs = repairs(cookie, job.id)

    const added = await jobRepairs.add({ priceItemId: price.id, quantity: 1 }).expect(200)
    const removed = await jobRepairs.remove(added.body.charges.lines[0].id).expect(200)
    expect(removed.body.charges.lines).toEqual([])

    const again = await jobRepairs.add({ priceItemId: price.id, quantity: 1 }).expect(200)
    await jobRepairs.decide('approved').expect(200)
    const locked = await jobRepairs.remove(again.body.charges.lines[0].id).expect(422)
    expect(locked.body.error.message).toBe('Only repairs waiting for the homeowner can be removed.')

    const unknown = await jobRepairs.remove(randomUUID()).expect(404)
    expect(unknown.body.error.message).toBe('That repair isn’t on this job.')
  })
})

describe('POST /api/my-jobs/:jobId/repairs/decision', () => {
  it('approves or declines every waiting repair at once', async () => {
    const { shop, job, cookie } = await mikesJob()
    const capacitor = await addPrice(shop, 'Capacitor replacement', 18500)
    const refrigerant = await addPrice(shop, 'Refrigerant (per lb)', 9500)
    const jobRepairs = repairs(cookie, job.id)
    await jobRepairs.add({ priceItemId: capacitor.id, quantity: 1 }).expect(200)
    await jobRepairs.add({ priceItemId: refrigerant.id, quantity: 2 }).expect(200)

    const approved = await jobRepairs.decide('approved').expect(200)
    const { lines } = approved.body.charges
    expect(lines.map((line: { status: string }) => line.status)).toEqual(['approved', 'approved'])
    expect(approved.body.charges).toMatchObject({ approvedTotalCents: 37500, proposedTotalCents: 0 })
    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'job.repairs_approved'))
    expect(audit.data).toEqual({
      itemIds: expect.arrayContaining(lines.map((line: { id: string }) => line.id)),
      totalCents: 37500,
      how: 'in_person',
    })

    await jobRepairs.add({ priceItemId: capacitor.id, quantity: 1 }).expect(200)
    const declined = await jobRepairs.decide('declined').expect(200)
    expect(declined.body.charges.lines.at(-1)).toMatchObject({
      status: 'declined',
      removable: false,
    })
    expect(declined.body.charges.approvedTotalCents).toBe(37500)

    const nothing = await jobRepairs.decide('approved').expect(422)
    expect(nothing.body.error.message).toBe('There are no repairs waiting for the homeowner.')
    await jobRepairs.decide('maybe').expect(400)
  })
})

describe('who can change repairs', () => {
  it("refuses another technician's job and office users", async () => {
    const { shop, cookie } = await mikesJob()
    const anas = await createJob(shop, {
      technicianId: shop.ana.id,
      at: `${today()} 08:00`,
      status: 'in_progress',
    })
    const price = await addPrice(shop, 'Thermostat replacement', 21000)

    const res = await repairs(cookie, anas.id)
      .add({ priceItemId: price.id, quantity: 1 })
      .expect(404)
    expect(res.body.error.message).toBe('This job isn’t assigned to you anymore.')
    await repairs(shop.cookie, anas.id).add({ priceItemId: price.id, quantity: 1 }).expect(403)
  })
})

describe('GET /api/my-jobs/price-items', () => {
  it('lists the active prices by name, for technicians only', async () => {
    const { shop, cookie } = await mikesJob()
    const thermostat = await addPrice(shop, 'Thermostat replacement', 21000)
    const capacitor = await addPrice(shop, 'Capacitor replacement', 18500)
    await addPrice(shop, 'Old part', 5000, true)

    const res = await request(app).get('/api/my-jobs/price-items').set('Cookie', cookie).expect(200)

    expect(res.body).toEqual({
      priceItems: [
        { id: capacitor.id, name: 'Capacitor replacement', priceCents: 18500 },
        { id: thermostat.id, name: 'Thermostat replacement', priceCents: 21000 },
      ],
    })
    await request(app).get('/api/my-jobs/price-items').set('Cookie', shop.cookie).expect(403)
  })
})
```

In `relay-api/src/modules/dispatch/dispatch.test.ts`, in `'returns everything the job drawer shows'`, add after the `photos` expectation:

```ts
    // A job made straight in the database has no booked lines.
    expect(res.body.charges).toEqual({ lines: [], approvedTotalCents: 0, proposedTotalCents: 0 })
```

In `relay-api/src/modules/technician-jobs/technician-jobs.test.ts`, in the first test of `describe('GET /api/my-jobs/:jobId', …)`, add after the `photos` expectation:

```ts
    expect(res.body.charges).toEqual({ lines: [], approvedTotalCents: 0, proposedTotalCents: 0 })
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/modules/technician-jobs src/modules/dispatch/dispatch.test.ts`
Expected: FAIL. Repair routes answer `404` (missing), `/api/my-jobs/price-items` answers `400` (taken as a job id), and neither page has `charges`.

- [ ] **Step 3: Add the event**

In `relay-api/src/realtime/events.ts`, add to `RealtimeEvents` after `'job.status_changed'`:

```ts
  // A repair was added, removed, approved or declined on the job.
  'job.charges_changed': JobChange
```

- [ ] **Step 4: Add the charges queries for repairs**

In `relay-api/src/modules/charges/charges.queries.ts`, change the imports to:

```ts
import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { type Db, db, type Tx } from '../../db/client.ts'
import { jobItems, jobs, priceItems, services, tenants } from '../../db/schema.ts'
```

and append:

```ts
// The job's status, technician and local day, locked until the transaction ends, so a status
// change can't slip in between the check and the change.
export async function lockJob(tenantId: string, jobId: string, tx: Tx) {
  const [job] = await tx
    .select({
      status: jobs.status,
      technicianId: jobs.technicianId,
      date: sql<string>`to_char(${jobs.windowStartsAt} at time zone ${tenants.timezone}, 'YYYY-MM-DD')`,
    })
    .from(jobs)
    .innerJoin(tenants, eq(tenants.id, jobs.tenantId))
    .where(and(eq(jobs.tenantId, tenantId), eq(jobs.id, jobId)))
    .for('update', { of: jobs })
  return job
}

export async function findActivePriceItem(tenantId: string, priceItemId: string, tx: Db) {
  const [item] = await tx
    .select({ name: priceItems.name, priceCents: priceItems.priceCents })
    .from(priceItems)
    .where(
      and(
        eq(priceItems.tenantId, tenantId),
        eq(priceItems.id, priceItemId),
        isNull(priceItems.archivedAt),
      ),
    )
  return item
}

export async function findLine(tenantId: string, jobId: string, itemId: string, tx: Db) {
  const [line] = await tx
    .select({ status: jobItems.status })
    .from(jobItems)
    .where(and(eq(jobItems.tenantId, tenantId), eq(jobItems.jobId, jobId), eq(jobItems.id, itemId)))
  return line
}

export async function deleteLine(tenantId: string, itemId: string, tx: Db) {
  await tx.delete(jobItems).where(and(eq(jobItems.tenantId, tenantId), eq(jobItems.id, itemId)))
}

// Marks every line waiting for the homeowner approved or declined. Returns the decided lines.
export function decideProposed(
  tenantId: string,
  jobId: string,
  status: 'approved' | 'declined',
  tx: Db,
) {
  return tx
    .update(jobItems)
    .set({ status })
    .where(
      and(
        eq(jobItems.tenantId, tenantId),
        eq(jobItems.jobId, jobId),
        eq(jobItems.status, 'proposed'),
      ),
    )
    .returning({ id: jobItems.id, quantity: jobItems.quantity, unitPriceCents: jobItems.unitPriceCents })
}
```

- [ ] **Step 5: Add the repair functions**

In `relay-api/src/modules/charges/charges.service.ts`, change the imports to:

```ts
import { type Db, db, type Tx } from '../../db/client.ts'
import type { PRICE_TYPES } from '../../db/schema.ts'
import { HttpError } from '../../lib/http-error.ts'
import { emitToTenant } from '../../realtime/index.ts'
import * as audit from '../audit/audit.queries.ts'
import * as queries from './charges.queries.ts'
```

and append:

```ts
type Actor = { tenantId: string; userId: string }
type CheckJob = (job: { technicianId: string | null }) => void

// One change to a job's repairs: only while the job is in progress, recorded in the audit log
// with what changed, and announced so open screens reload. `checkJob` runs on the locked job
// first (the technician side checks the job is still theirs).
async function changeRepairs(
  actor: Actor,
  jobId: string,
  checkJob: CheckJob | undefined,
  change: (tx: Tx) => Promise<{ action: string; data: Record<string, unknown> }>,
) {
  const date = await db.transaction(async (tx) => {
    const job = await queries.lockJob(actor.tenantId, jobId, tx)
    if (!job) throw new HttpError(404, 'not_found', 'This job isn’t on the board anymore.')
    checkJob?.(job)
    if (job.status !== 'in_progress') {
      throw new HttpError(422, 'invalid_transition', 'Start the job before adding repairs.')
    }
    const { action, data } = await change(tx)
    await audit.insertUserAction(
      actor.tenantId,
      { actorUserId: actor.userId, action, entityType: 'job', entityId: jobId, data },
      tx,
    )
    return job.date
  })
  emitToTenant(actor.tenantId, 'job.charges_changed', { jobId, dates: [date] })
}

// A repair from the price list, at its listed price, waiting for the homeowner.
export function proposeRepair(
  actor: Actor,
  jobId: string,
  input: { priceItemId: string; quantity: number },
  checkJob?: CheckJob,
) {
  return changeRepairs(actor, jobId, checkJob, async (tx) => {
    const price = await queries.findActivePriceItem(actor.tenantId, input.priceItemId, tx)
    if (!price) {
      throw new HttpError(422, 'not_on_list', 'That price isn’t on the list anymore.')
    }
    const [line] = await queries.insertLines(
      actor.tenantId,
      [
        {
          jobId,
          priceItemId: input.priceItemId,
          description: price.name,
          quantity: input.quantity,
          unitPriceCents: price.priceCents,
          status: 'proposed',
          createdBy: actor.userId,
        },
      ],
      tx,
    )
    return {
      action: 'job.repair_proposed',
      data: {
        itemId: line.id,
        description: price.name,
        quantity: input.quantity,
        unitPriceCents: price.priceCents,
      },
    }
  })
}

export function removeRepair(actor: Actor, jobId: string, itemId: string, checkJob?: CheckJob) {
  return changeRepairs(actor, jobId, checkJob, async (tx) => {
    const line = await queries.findLine(actor.tenantId, jobId, itemId, tx)
    if (!line) throw new HttpError(404, 'not_found', 'That repair isn’t on this job.')
    if (line.status !== 'proposed') {
      throw new HttpError(422, 'locked', 'Only repairs waiting for the homeowner can be removed.')
    }
    await queries.deleteLine(actor.tenantId, itemId, tx)
    return { action: 'job.repair_removed', data: { itemId } }
  })
}

// The homeowner's answer, given in person on the technician's phone, for every waiting repair.
export function decideRepairs(
  actor: Actor,
  jobId: string,
  decision: 'approved' | 'declined',
  checkJob?: CheckJob,
) {
  return changeRepairs(actor, jobId, checkJob, async (tx) => {
    const decided = await queries.decideProposed(actor.tenantId, jobId, decision, tx)
    if (decided.length === 0) {
      throw new HttpError(422, 'nothing_to_decide', 'There are no repairs waiting for the homeowner.')
    }
    return {
      action: decision === 'approved' ? 'job.repairs_approved' : 'job.repairs_declined',
      data: {
        itemIds: decided.map((line) => line.id),
        totalCents: decided.reduce((total, line) => total + line.quantity * line.unitPriceCents, 0),
        how: 'in_person',
      },
    }
  })
}
```

(The `Db` import stays for `addBookedLines`.)

- [ ] **Step 6: Add the technician's input schemas**

Append to `relay-api/src/modules/technician-jobs/technician-jobs.schemas.ts`:

```ts
export const RepairInput = z.object({
  priceItemId: z.uuid('Pick a repair from the list'),
  quantity: z
    .number('Pick a quantity from 1 to 20')
    .int('Pick a quantity from 1 to 20')
    .min(1, 'Pick a quantity from 1 to 20')
    .max(20, 'Pick a quantity from 1 to 20'),
})

export const DecisionInput = z.object({
  decision: z.enum(['approved', 'declined'], 'Pick approve or decline'),
})

export const RepairParams = JobParams.extend({
  itemId: z.uuid('That repair isn’t on this job.'),
})
```

and add the import `import { JobParams } from '../dispatch/dispatch.schemas.ts'`.

- [ ] **Step 7: Add the technician's service functions and charges on the job page**

In `relay-api/src/modules/technician-jobs/technician-jobs.service.ts`, add the imports:

```ts
import * as catalog from '../catalog/catalog.service.ts'
import * as charges from '../charges/charges.service.ts'
```

In `getMyJob`, add `charges.getCharges(tenantId, jobId)` to the `Promise.all` (destructure it as `jobCharges`), and add `charges: jobCharges,` to the returned object after `photos`.

Append:

```ts
// The price list a technician picks repairs from.
export function listPriceList(user: SessionUser) {
  return catalog.listActivePriceItems(tenantOf(user))
}

// Repairs on one of the technician's own jobs. Each checks the job is theirs, changes it
// through charges (where the rules live), and answers with the refreshed job page.
async function changeMyRepairs(
  user: SessionUser,
  jobId: string,
  change: (actor: { tenantId: string; userId: string }, checkJob: (job: { technicianId: string | null }) => void) => Promise<void>,
) {
  await findMyJob(user, jobId)
  await change({ tenantId: tenantOf(user), userId: user.id }, (job) => {
    // The office may have reassigned the job since the check above.
    if (job.technicianId !== user.id) throw notYours()
  })
  return getMyJob(user, jobId)
}

export function addRepair(user: SessionUser, jobId: string, input: { priceItemId: string; quantity: number }) {
  return changeMyRepairs(user, jobId, (actor, checkJob) =>
    charges.proposeRepair(actor, jobId, input, checkJob),
  )
}

export function removeRepair(user: SessionUser, jobId: string, itemId: string) {
  return changeMyRepairs(user, jobId, (actor, checkJob) =>
    charges.removeRepair(actor, jobId, itemId, checkJob),
  )
}

export function decideRepairs(user: SessionUser, jobId: string, decision: 'approved' | 'declined') {
  return changeMyRepairs(user, jobId, (actor, checkJob) =>
    charges.decideRepairs(actor, jobId, decision, checkJob),
  )
}
```

- [ ] **Step 8: Add the technician routes**

In `relay-api/src/modules/technician-jobs/technician-jobs.routes.ts`:

Change the schemas import to `import { DecisionInput, NoAccessInput, OnMyWayInput, RepairInput, RepairParams, RunningLateInput } from './technician-jobs.schemas.ts'`.

Add **directly above** the `technicianJobsRoutes.get('/my-jobs/:jobId', …)` route (Express matches in order; `price-items` would otherwise be read as a job id):

```ts
technicianJobsRoutes.get('/my-jobs/price-items', technician, async (req, res) => {
  res.json({ priceItems: await technicianJobs.listPriceList(req.user!) })
})
```

and append:

```ts
technicianJobsRoutes.post('/my-jobs/:jobId/repairs', technician, async (req, res) => {
  const { jobId } = JobParams.parse(req.params)
  const input = RepairInput.parse(req.body)
  res.json(await technicianJobs.addRepair(req.user!, jobId, input))
})

technicianJobsRoutes.delete('/my-jobs/:jobId/repairs/:itemId', technician, async (req, res) => {
  const { jobId, itemId } = RepairParams.parse(req.params)
  res.json(await technicianJobs.removeRepair(req.user!, jobId, itemId))
})

technicianJobsRoutes.post('/my-jobs/:jobId/repairs/decision', technician, async (req, res) => {
  const { jobId } = JobParams.parse(req.params)
  const { decision } = DecisionInput.parse(req.body)
  res.json(await technicianJobs.decideRepairs(req.user!, jobId, decision))
})
```

- [ ] **Step 9: Show the charges in the office drawer**

In `relay-api/src/modules/dispatch/dispatch.service.ts`, add `import * as charges from '../charges/charges.service.ts'`; in `getJob`, add `charges.getCharges(tenantId, jobId)` to the `Promise.all` (as `jobCharges`) and `charges: jobCharges,` to the returned object after `photos`.

- [ ] **Step 10: Run the tests**

Run: `npx vitest run src/modules/technician-jobs src/modules/dispatch src/modules/charges`
Expected: PASS.

Run: `npm test`
Expected: PASS.

- [ ] **Step 11: Typecheck, lint, commit**

```bash
npm run typecheck
npx biome check --write src/realtime/events.ts src/modules/charges/charges.queries.ts src/modules/charges/charges.service.ts src/modules/technician-jobs/technician-jobs.schemas.ts src/modules/technician-jobs/technician-jobs.service.ts src/modules/technician-jobs/technician-jobs.routes.ts src/modules/technician-jobs/repairs.test.ts src/modules/dispatch/dispatch.service.ts src/modules/dispatch/dispatch.test.ts
git add src/realtime/events.ts src/modules/charges src/modules/technician-jobs src/modules/dispatch
git commit -m "feat: let technicians add repairs and record the homeowner's decision"
```

---

### Task 4: Web — money formatting and the repair price list screen

**Files:**
- Modify: `relay-web/src/lib/format.ts`, `relay-web/src/lib/format.test.ts`
- Modify: `relay-web/src/features/catalog/prices.ts` (`priceLabel` uses `formatMoney`)
- Modify: `relay-web/src/features/catalog/api.ts`
- Create: `relay-web/src/features/catalog/price-item-dialog.tsx`, `relay-web/src/features/catalog/repair-prices.tsx`
- Modify: `relay-web/src/routes/services.tsx` (render `<RepairPrices />`)

**Interfaces:**
- Produces: `formatMoney(cents: number): string`; `type PriceItem = { id, name, priceCents, archived }`; `usePriceItems()`, `useSavePriceItem()`, `useArchivePriceItem()`, `useRestorePriceItem()`; `RepairPrices()`.

- [ ] **Step 1: Write the failing test**

Append to `relay-web/src/lib/format.test.ts` (and add `formatMoney` to its import):

```ts
it('shows money in dollars, with cents only when there are some', () => {
  expect(formatMoney(8900)).toBe('$89')
  expect(formatMoney(8950)).toBe('$89.50')
  expect(formatMoney(123450)).toBe('$1,234.50')
  expect(formatMoney(0)).toBe('$0')
})
```

- [ ] **Step 2: Run it to verify it fails**

Run (in `relay-web`): `npx vitest run src/lib/format.test.ts`
Expected: FAIL, `formatMoney is not a function`.

- [ ] **Step 3: Add `formatMoney` and use it in `priceLabel`**

Append to `relay-web/src/lib/format.ts`:

```ts
// 8900 → '$89', 8950 → '$89.50', 123450 → '$1,234.50'. Cents are shown only when there are
// some.
export function formatMoney(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`
}
```

In `relay-web/src/features/catalog/prices.ts`, add `import { formatMoney } from '@/lib/format'` and replace the body of `priceLabel` after the `free` line with:

```ts
  const price = formatMoney(priceCents)
  return priceType === 'diagnostic' ? `${price} diagnostic fee` : price
```

Run: `npx vitest run src/lib/format.test.ts src/features/catalog/prices.test.ts`
Expected: PASS.

- [ ] **Step 4: Add the price list hooks**

Append to `relay-web/src/features/catalog/api.ts`:

```ts
// The repair price list. Technicians add these to jobs; the homeowner approves the price.
const PriceItem = z.object({
  id: z.string(),
  name: z.string(),
  priceCents: z.number(),
  archived: z.boolean(),
})
export type PriceItem = z.infer<typeof PriceItem>
const PriceItemList = z.object({ priceItems: z.array(PriceItem) })
const OnePriceItem = z.object({ priceItem: PriceItem })

const priceItemsKey = ['catalog', 'price-items']

// Active prices first, then archived ones, each by name.
export function usePriceItems() {
  return useQuery({
    queryKey: priceItemsKey,
    queryFn: () => api.get('/price-items', PriceItemList),
    select: (data) => data.priceItems,
  })
}

function useRefreshPriceItems() {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: priceItemsKey })
}

export function useSavePriceItem() {
  const refresh = useRefreshPriceItems()
  return useMutation({
    mutationFn: ({ id, ...input }: { id?: string; name: string; priceCents: number }) =>
      id
        ? api.patch(`/price-items/${id}`, input, OnePriceItem)
        : api.post('/price-items', input, OnePriceItem),
    onSuccess: refresh,
  })
}

export function useArchivePriceItem() {
  const refresh = useRefreshPriceItems()
  return useMutation({
    mutationFn: (id: string) => api.post(`/price-items/${id}/archive`, undefined, OnePriceItem),
    onSuccess: refresh,
  })
}

export function useRestorePriceItem() {
  const refresh = useRefreshPriceItems()
  return useMutation({
    mutationFn: (id: string) => api.post(`/price-items/${id}/restore`, undefined, OnePriceItem),
    onSuccess: refresh,
  })
}
```

- [ ] **Step 5: Add the add/edit dialog**

Create `relay-web/src/features/catalog/price-item-dialog.tsx`:

```tsx
import { type FormEvent, useState } from 'react'
import { toast } from 'sonner'
import { Field, type FieldErrors } from '@/components/form-field'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ApiError } from '@/lib/api'
import { errorMessage } from '@/lib/errors'
import { type PriceItem, useSavePriceItem } from './api'
import { dollarsToCents, priceInput } from './prices'

// Add a repair price (`item` = 'new') or edit one. Closed when `item` is null.
export function PriceItemDialog({
  item,
  onClose,
}: {
  item: PriceItem | 'new' | null
  onClose: () => void
}) {
  const editing = item !== null && item !== 'new' ? item : null
  return (
    <Dialog open={item !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${editing.name}` : 'Add repair price'}</DialogTitle>
          <DialogDescription>
            Technicians add these to a job, and the homeowner approves the price before the work.
            A new price applies to repairs added from now on.
          </DialogDescription>
        </DialogHeader>
        {/* Mounted only while open, so each opening starts from the saved values. */}
        {item !== null && (
          <PriceItemForm key={editing?.id ?? 'new'} editing={editing} onDone={onClose} />
        )}
      </DialogContent>
    </Dialog>
  )
}

function PriceItemForm({ editing, onDone }: { editing: PriceItem | null; onDone: () => void }) {
  const [name, setName] = useState(editing?.name ?? '')
  const [price, setPrice] = useState(editing ? priceInput(editing.priceCents) : '')
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const save = useSavePriceItem()

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    const priceCents = dollarsToCents(price)
    if (priceCents === null) {
      setFieldErrors({ priceCents: ['Enter a price in dollars and cents, like 185 or 185.50'] })
      return
    }
    save.mutate(
      { id: editing?.id, name, priceCents },
      {
        onSuccess: ({ priceItem }) => {
          toast.success(editing ? `Saved ${priceItem.name}` : `Added ${priceItem.name}`)
          onDone()
        },
        onError: (error) => {
          if (error instanceof ApiError && error.code === 'validation_failed') {
            setFieldErrors(error.details)
          } else {
            setFieldErrors({})
            toast.error(errorMessage(error))
          }
        },
      },
    )
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <Field id="price-item-name" label="Repair" errors={fieldErrors.name}>
        <Input
          id="price-item-name"
          maxLength={100}
          placeholder="Capacitor replacement"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <Field id="price-item-price" label="Price ($)" errors={fieldErrors.priceCents}>
        <Input
          id="price-item-price"
          inputMode="decimal"
          placeholder="185.00"
          value={price}
          onChange={(event) => setPrice(event.target.value)}
        />
      </Field>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
      </DialogFooter>
    </form>
  )
}
```

- [ ] **Step 6: Add the Repair prices section**

Create `relay-web/src/features/catalog/repair-prices.tsx`:

```tsx
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { type Confirmation, ConfirmDialog } from '@/components/confirm-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { errorMessage } from '@/lib/errors'
import { formatMoney } from '@/lib/format'
import { type PriceItem, useArchivePriceItem, usePriceItems, useRestorePriceItem } from './api'
import { PriceItemDialog } from './price-item-dialog'

// The contractor's repair price list, under their services. Prices are archived, never
// deleted, so jobs that used one keep it.
export function RepairPrices() {
  const items = usePriceItems()
  const archive = useArchivePriceItem()
  const restore = useRestorePriceItem()
  const [editing, setEditing] = useState<PriceItem | 'new' | null>(null)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)

  function askToArchive(item: PriceItem) {
    setConfirmation({
      title: `Archive ${item.name}?`,
      message: `Technicians won’t be able to add ${item.name} to jobs. Jobs that already have it keep it, and you can restore it anytime.`,
      confirmLabel: 'Archive',
      destructive: true,
      onConfirm: () =>
        archive.mutate(item.id, {
          onSuccess: () => toast.success(`${item.name} archived`),
          onError: (error) => toast.error(errorMessage(error)),
        }),
    })
  }

  function onRestore(item: PriceItem) {
    restore.mutate(item.id, {
      onSuccess: () => toast.success(`${item.name} is back on the list`),
      onError: (error) => toast.error(errorMessage(error)),
    })
  }

  return (
    <section className="space-y-3 pt-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Repair prices</h2>
          <p className="text-sm text-muted-foreground">
            Technicians add these to a job, and the homeowner approves the price first.
          </p>
        </div>
        <Button variant="outline" onClick={() => setEditing('new')}>
          <Plus /> Add repair price
        </Button>
      </div>

      {items.isPending && <p className="text-muted-foreground">Loading prices…</p>}
      {items.isError && (
        <div className="space-y-2 rounded-lg border border-destructive/30 p-4">
          <p className="text-sm text-destructive">{errorMessage(items.error)}</p>
          <Button variant="outline" size="sm" onClick={() => items.refetch()}>
            Try again
          </Button>
        </div>
      )}
      {items.data?.length === 0 && (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          No repair prices yet. Add the repairs your technicians do most, like a capacitor
          replacement.
        </p>
      )}

      <ul className="space-y-2">
        {items.data?.map((item) => (
          <li key={item.id} className="flex flex-wrap items-center gap-3 rounded-xl border bg-card p-4">
            <div className="min-w-0 flex-1">
              <p className="font-medium">
                {item.name}{' '}
                {item.archived && <Badge className="bg-zinc-100 text-zinc-600">Archived</Badge>}
              </p>
              <p className="text-sm text-muted-foreground">{formatMoney(item.priceCents)}</p>
            </div>
            <Button variant="outline" size="sm" onClick={() => setEditing(item)}>
              Edit
            </Button>
            {item.archived ? (
              <Button
                variant="outline"
                size="sm"
                disabled={restore.isPending}
                onClick={() => onRestore(item)}
              >
                Restore
              </Button>
            ) : (
              <Button
                variant="destructive"
                size="sm"
                disabled={archive.isPending}
                onClick={() => askToArchive(item)}
              >
                Archive
              </Button>
            )}
          </li>
        ))}
      </ul>

      <PriceItemDialog item={editing} onClose={() => setEditing(null)} />
      <ConfirmDialog confirmation={confirmation} onClose={() => setConfirmation(null)} />
    </section>
  )
}
```

- [ ] **Step 7: Put it on the Services screen**

In `relay-web/src/routes/services.tsx`, add `import { RepairPrices } from '@/features/catalog/repair-prices'` and render `<RepairPrices />` right after the closing `</DndContext>` (before `<ServiceDialog …/>`).

- [ ] **Step 8: Typecheck, test, lint, commit**

```bash
npm run typecheck
npm test
npx biome check --write src/lib/format.ts src/lib/format.test.ts src/features/catalog/prices.ts src/features/catalog/api.ts src/features/catalog/price-item-dialog.tsx src/features/catalog/repair-prices.tsx src/routes/services.tsx
git add src/lib/format.ts src/lib/format.test.ts src/features/catalog src/routes/services.tsx
git commit -m "feat: add the repair price list to the Services screen"
```

---

### Task 5: Web — charges on the job page and in the office drawer

**Files:**
- Create: `relay-web/src/features/charges/api.ts`, `relay-web/src/features/charges/charge-lines.tsx`
- Modify: `relay-web/src/lib/socket.ts` (event type)
- Modify: `relay-web/src/features/dispatch/api.ts` (`JobDetail.charges`, live updates), `job-drawer.tsx` (Charges section)
- Modify: `relay-web/src/features/technician-jobs/api.ts` (`MyJob.charges`, `usePriceList`, `useRepairAction`, live updates)
- Create: `relay-web/src/features/technician-jobs/job-charges.tsx`
- Modify: `relay-web/src/features/technician-jobs/job-details.tsx` (Charges section)

**Interfaces:**
- Consumes: `charges` on both job APIs, the technician repair routes and price list (Task 3); `formatMoney` (Task 4).
- Produces: `Charges` schema and type; `ChargeLines({ charges, onRemove?, busy? })`; `RepairAction` type; `useRepairAction(jobId)`; `usePriceList()`; `JobCharges({ job, charges })`.

- [ ] **Step 1: Add the shared Charges schema and lines component**

Create `relay-web/src/features/charges/api.ts`:

```ts
import { z } from 'zod'

// A job's charges, the same on the technician's job page and the office's drawer: the booked
// lines (the service, priority service) and repairs with the homeowner's decision.
export const Charges = z.object({
  lines: z.array(
    z.object({
      id: z.string(),
      description: z.string(),
      quantity: z.number(),
      unitPriceCents: z.number(),
      totalCents: z.number(),
      status: z.enum(['proposed', 'approved', 'declined']),
      removable: z.boolean(), // a repair still waiting for the homeowner
    }),
  ),
  approvedTotalCents: z.number(),
  proposedTotalCents: z.number(),
})
export type Charges = z.infer<typeof Charges>
```

Create `relay-web/src/features/charges/charge-lines.tsx`:

```tsx
import { cn } from 'cn'
import { X } from 'lucide-react'
import { formatMoney } from '@/lib/format'
import type { Charges } from './api'

// A job's lines with their totals. `onRemove` adds a remove button to repairs still waiting
// for the homeowner (the technician's page); the office's drawer leaves it out.
export function ChargeLines({
  charges,
  onRemove,
  busy = false,
}: {
  charges: Charges
  onRemove?: (lineId: string) => void
  busy?: boolean
}) {
  return (
    <div className="space-y-2">
      <ul className="divide-y">
        {charges.lines.map((line) => (
          <li key={line.id} className="flex items-start gap-2 py-2">
            <div className="min-w-0 flex-1">
              <p className={cn(line.status === 'declined' && 'text-muted-foreground line-through')}>
                {line.description}
                {line.quantity > 1 && ` × ${line.quantity}`}
              </p>
              {line.status === 'proposed' && (
                <p className="text-xs font-medium text-amber-700">Waiting for the homeowner</p>
              )}
              {line.status === 'declined' && (
                <p className="text-xs text-muted-foreground">Declined</p>
              )}
            </div>
            <span className={cn('shrink-0 tabular-nums', line.status === 'declined' && 'text-muted-foreground line-through')}>
              {formatMoney(line.totalCents)}
            </span>
            {onRemove && line.removable && (
              <button
                type="button"
                aria-label={`Remove ${line.description}`}
                disabled={busy}
                className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
                onClick={() => onRemove(line.id)}
              >
                <X className="size-4" />
              </button>
            )}
          </li>
        ))}
      </ul>
      <p className="flex justify-between font-medium">
        <span>Approved so far</span>
        <span className="tabular-nums">{formatMoney(charges.approvedTotalCents)}</span>
      </p>
    </div>
  )
}
```

- [ ] **Step 2: Add the event type and the office side**

In `relay-web/src/lib/socket.ts`, add to `RealtimeEvents` after `'job.status_changed'`:

```ts
  'job.charges_changed': JobChange
```

In `relay-web/src/features/dispatch/api.ts`, add `import { Charges } from '@/features/charges/api'`; add `charges: Charges,` to the `JobDetail` object after `photos`; and in `useDispatchLiveUpdates` add:

```ts
  useSocketEvent('job.charges_changed', onChange)
```

In `relay-web/src/features/dispatch/job-drawer.tsx`, add `import { ChargeLines } from '@/features/charges/charge-lines'`; in `JobDetails` change `const { job, notes, photos } = detail` to `const { job, notes, photos, charges } = detail`, and add after the Problem `</section>`:

```tsx
        <section className="space-y-1 text-sm">
          <h3 className="font-medium">Charges</h3>
          <ChargeLines charges={charges} />
        </section>
```

- [ ] **Step 3: Add the technician hooks**

In `relay-web/src/features/technician-jobs/api.ts`, add `import { Charges } from '@/features/charges/api'`; add `charges: Charges,` to the `MyJob` object after `photos`; add to `useMyJobsLiveUpdates`:

```ts
  useSocketEvent('job.charges_changed', reload)
```

and append:

```ts
const PriceList = z.object({
  priceItems: z.array(z.object({ id: z.string(), name: z.string(), priceCents: z.number() })),
})

// The repairs a technician can add, by name.
export function usePriceList() {
  return useQuery({
    queryKey: [...myJobsKey, 'price-list'],
    queryFn: () => api.get('/my-jobs/price-items', PriceList),
    select: (data) => data.priceItems,
  })
}

// A change to the job's repairs. Each answers with the refreshed job page.
export type RepairAction =
  | { action: 'add'; priceItemId: string; quantity: number }
  | { action: 'remove'; itemId: string }
  | { action: 'decide'; decision: 'approved' | 'declined' }

function sendRepairAction(jobId: string, change: RepairAction) {
  const repairs = `/my-jobs/${jobId}/repairs`
  if (change.action === 'add') {
    return api.post(repairs, { priceItemId: change.priceItemId, quantity: change.quantity }, MyJob)
  }
  if (change.action === 'remove') return api.delete(`${repairs}/${change.itemId}`, MyJob)
  return api.post(`${repairs}/decision`, { decision: change.decision }, MyJob)
}

export function useRepairAction(jobId: string) {
  const queryClient = useQueryClient()
  const jobKey = [...myJobsKey, 'job', jobId]
  return useMutation({
    mutationFn: (change: RepairAction) => sendRepairAction(jobId, change),
    onSuccess: (detail) => queryClient.setQueryData(jobKey, detail),
    // The job or the price list changed under the technician: show them as they are.
    onError: () => queryClient.invalidateQueries({ queryKey: myJobsKey }),
  })
}
```

- [ ] **Step 4: Add the Charges section with its two sheets**

Create `relay-web/src/features/technician-jobs/job-charges.tsx`:

```tsx
import { cn } from 'cn'
import { Loader2, Minus, Plus } from 'lucide-react'
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import type { Charges } from '@/features/charges/api'
import { ChargeLines } from '@/features/charges/charge-lines'
import { NetworkError } from '@/lib/api'
import { errorMessage } from '@/lib/errors'
import { formatMoney } from '@/lib/format'
import { type MyJob, type RepairAction, usePriceList, useRepairAction } from './api'

// The job's charges on the technician's page. While the visit is in progress the technician
// adds repairs from the price list and hands the phone over for the homeowner's decision.
export function JobCharges({ job, charges }: { job: MyJob['job']; charges: Charges }) {
  const [sheet, setSheet] = useState<'add' | 'review' | null>(null)
  const action = useRepairAction(job.id)
  const inProgress = job.status === 'in_progress'
  const waiting = charges.lines.some((line) => line.status === 'proposed')

  function run(change: RepairAction, onDone?: () => void) {
    action.mutate(change, {
      onSuccess: () => onDone?.(),
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

  return (
    <div className="space-y-3">
      <ChargeLines
        charges={charges}
        busy={action.isPending}
        onRemove={inProgress ? (itemId) => run({ action: 'remove', itemId }) : undefined}
      />
      {inProgress && (
        <div className="grid gap-2 sm:grid-cols-2">
          <Button
            variant="outline"
            className="h-11"
            disabled={action.isPending}
            onClick={() => setSheet('add')}
          >
            <Plus /> Add repair
          </Button>
          {waiting && (
            <Button className="h-11" disabled={action.isPending} onClick={() => setSheet('review')}>
              Review with homeowner
            </Button>
          )}
        </div>
      )}

      <AddRepairSheet
        open={sheet === 'add'}
        busy={action.isPending}
        onAdd={(priceItemId, quantity) =>
          run({ action: 'add', priceItemId, quantity }, () => setSheet(null))
        }
        onClose={() => setSheet(null)}
      />
      <ReviewSheet
        open={sheet === 'review'}
        charges={charges}
        busy={action.isPending}
        onDecide={(decision) => run({ action: 'decide', decision }, () => setSheet(null))}
        onClose={() => setSheet(null)}
      />
    </div>
  )
}

// Pick a repair from the price list and how many.
function AddRepairSheet(props: {
  open: boolean
  busy: boolean
  onAdd: (priceItemId: string, quantity: number) => void
  onClose: () => void
}) {
  const prices = usePriceList()
  const [picked, setPicked] = useState<string | null>(null)
  const [quantity, setQuantity] = useState(1)
  const price = prices.data?.find((item) => item.id === picked)

  function close() {
    setPicked(null)
    setQuantity(1)
    props.onClose()
  }

  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add repair</DialogTitle>
          <DialogDescription>The homeowner approves the price before you start.</DialogDescription>
        </DialogHeader>
        {prices.isPending && <p className="text-muted-foreground">Loading prices…</p>}
        {prices.isError && <p className="text-sm text-destructive">{errorMessage(prices.error)}</p>}
        {prices.data?.length === 0 && (
          <p className="text-sm text-muted-foreground">The office hasn’t added any repair prices yet.</p>
        )}
        <ul className="space-y-2">
          {prices.data?.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                aria-pressed={picked === item.id}
                className={cn(
                  'flex w-full items-center justify-between gap-3 rounded-lg border p-3 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
                  picked === item.id && 'border-primary bg-primary/5 ring-1 ring-primary',
                )}
                onClick={() => setPicked(item.id)}
              >
                <span>{item.name}</span>
                <span className="tabular-nums">{formatMoney(item.priceCents)}</span>
              </button>
            </li>
          ))}
        </ul>
        {price && (
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium">Quantity</span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="icon-lg"
                aria-label="One fewer"
                disabled={quantity <= 1}
                onClick={() => setQuantity(quantity - 1)}
              >
                <Minus />
              </Button>
              <span className="w-8 text-center tabular-nums">{quantity}</span>
              <Button
                variant="outline"
                size="icon-lg"
                aria-label="One more"
                disabled={quantity >= 20}
                onClick={() => setQuantity(quantity + 1)}
              >
                <Plus />
              </Button>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button
            disabled={!price || props.busy}
            onClick={() => price && props.onAdd(price.id, quantity)}
          >
            {props.busy && <Loader2 className="animate-spin" />}
            {price ? `Add ${formatMoney(price.priceCents * quantity)}` : 'Add'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// Handed to the homeowner, full screen: every line, the total if they approve, and their
// answer. "Not now" closes it and records nothing.
function ReviewSheet(props: {
  open: boolean
  charges: Charges
  busy: boolean
  onDecide: (decision: 'approved' | 'declined') => void
  onClose: () => void
}) {
  const total = formatMoney(props.charges.approvedTotalCents + props.charges.proposedTotalCents)
  return (
    <Sheet open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <SheetContent side="bottom" className="h-dvh">
        <SheetHeader>
          <SheetTitle className="text-xl">Your repair estimate</SheetTitle>
          <SheetDescription>
            Please check the repairs below. Your technician starts once you approve.
          </SheetDescription>
        </SheetHeader>
        <div className="flex-1 space-y-4 overflow-y-auto px-4 text-base">
          <ChargeLines charges={props.charges} />
          <p className="flex justify-between text-lg font-semibold">
            <span>Total if approved</span>
            <span className="tabular-nums">{total}</span>
          </p>
        </div>
        <SheetFooter>
          <Button
            className="h-12 text-base"
            disabled={props.busy}
            onClick={() => props.onDecide('approved')}
          >
            {props.busy && <Loader2 className="animate-spin" />}
            Approve {total}
          </Button>
          <Button
            variant="outline"
            className="h-11"
            disabled={props.busy}
            onClick={() => props.onDecide('declined')}
          >
            Decline repairs
          </Button>
          <Button variant="ghost" className="h-10" disabled={props.busy} onClick={props.onClose}>
            Not now
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
```

- [ ] **Step 5: Put the section on the job page**

In `relay-web/src/features/technician-jobs/job-details.tsx`, add `import { JobCharges } from './job-charges'`; change `const { job, notes, photos } = detail.data` to `const { job, notes, photos, charges } = detail.data`; and add before the `<Section title="Office notes">`:

```tsx
      <Section title="Charges">
        <JobCharges job={job} charges={charges} />
      </Section>
```

- [ ] **Step 6: Typecheck, test, lint, commit**

```bash
npm run typecheck
npm test
npx biome check --write src/features/charges/api.ts src/features/charges/charge-lines.tsx src/lib/socket.ts src/features/dispatch/api.ts src/features/dispatch/job-drawer.tsx src/features/technician-jobs/api.ts src/features/technician-jobs/job-charges.tsx src/features/technician-jobs/job-details.tsx
git add src/features/charges src/lib/socket.ts src/features/dispatch src/features/technician-jobs
git commit -m "feat: show charges and let technicians add repairs for the homeowner to approve"
```

Expected: typecheck prints nothing; all tests pass (the drawer and job page parse the new `charges`); Biome reports no errors.

---

### Task 6: Check it in the running app

**Files:** none in the repos.

- [ ] **Step 1: Migrate and confirm every job has its booked line**

Run (in `relay-api`): `npm run db:migrate`, then the psql count from Task 1, Step 9.
Expected: `0`.

- [ ] **Step 2: Office adds a price**

As `office@desert.test`, open Services. Expected: a **Repair prices** section (empty on an unseeded database; the starter prices after `npm run db:seed`). Add "Capacitor replacement", $185.

- [ ] **Step 3: Sam adds repairs**

As Sam at phone width, open an assigned job, tap **Start job**. Expected: **Charges** shows the booked service line (e.g. `AC repair (diagnostic fee)` $89) and "Approved so far: $89". Tap **Add repair**, pick the capacitor, quantity 1, Add; add a second repair. Expected: both show "Waiting for the homeowner" with remove buttons; **Review with homeowner** is enabled.

- [ ] **Step 4: Homeowner approves on Sam's phone, office sees it live**

Tap **Review with homeowner** → **Approve $…**. Expected: both repairs approved, "Approved so far" includes them; the office's job drawer (open in another browser) shows the same lines and total within a second.

- [ ] **Step 5: Report**

Report the screenshots and anything that didn't match.
