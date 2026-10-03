# Customers Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Owner and office get a Customers screen: a searchable, paged list; a record page with contact, notes, addresses with equipment and job history; and dialogs to add customers, edit contacts and edit addresses, plus "Book job" from the record.

**Architecture:** relay-api extends the existing `customers` module (routes → service → queries) with six routes. Contact and address field rules move into `customers.schemas.ts` and booking imports them, so each rule exists once. relay-web adds a `features/customers` folder and two routes. It reuses dispatch's `JobDrawer`, `BookJobDialog` and `STATUS` labels, and dispatch never imports `customers`. Formatting lives in small pure functions with their own tests.

**Tech Stack:** relay-api: Express 5, Drizzle ORM, PostgreSQL 18, Zod 4, Vitest + Supertest. relay-web: React 19, React Router 8, TanStack Query 5, Zod 4, Base UI dialogs (shadcn), sonner toasts, lucide icons, Vitest.

**Spec:** `relay-api/docs/superpowers/specs/2026-10-03-customers-screen-design.md`

## Global Constraints

- Two separate git repos: `relay-api` and `relay-web`. Branch `feat/customers-screen` in both, created from `main` in Task 1 / Task 6.
- Architecture: a rule lives in exactly one place. Modules keep routes → service → queries. `customers` (web) may import `dispatch`; `dispatch` never imports `customers`. Wording and formatting are pure functions with tests. Reuse existing queries before writing new SQL. Code stays plain enough for a junior developer to debug without AI: no speculative abstractions.
- Commit messages: lowercase conventional (`feat: …`, `refactor: …`, `test: …`, `docs: …`). **No `Co-Authored-By` trailer.**
- Biome only on touched files: `npx biome check --write <paths>`.
- relay-api tests need the local test database (`relay_test`, PostgreSQL 18, role `relay`/`relay`) running.
- Typographic apostrophes in user-facing copy (`’`), like the rest of the app.
- Page size 25 (API only; the web reads `pageSize` from the response). Notes limit 2000, access notes 1000, brand 50, install year 1950 to the current year.
- Exact copy:
  - API: customer 404 `That customer wasn’t found.`; address 404 `That address wasn’t found for this customer.`; notes too long `Keep the notes under 2,000 characters`; access notes too long `Keep the access notes under 1,000 characters`; brand too long `Keep the brand under 50 characters`; bad year `Check the equipment age`; empty change `Nothing to save`; bad ids `That customer link isn’t valid` / `That address link isn’t valid`.
  - Web: see each task; empty list `No customers yet`; no matches `No customers match “<q>”`; duplicate `<Name> already uses this number. Open that record`; notes empty `No notes. Add things like ‘prefers mornings’ or ‘pays by check’.`; moved hint `Customer moved? Add a new address instead, so past jobs keep the old one.`

## File map

relay-api:
- Create `src/modules/customers/customers.schemas.ts`: contact, address, list query, change and address bodies, route params.
- Modify `src/modules/customers/customers.queries.ts`: list with visit dates, extended `listProperties`, job history, updates.
- Modify `src/modules/customers/customers.service.ts`: `list`, `create`, `detail`, `update`, `addProperty`, `replaceProperty`.
- Modify `src/modules/customers/customers.routes.ts`: six routes.
- Modify `src/modules/customers/customers.test.ts`: rewritten for the new routes.
- Modify `src/modules/booking/booking.schemas.ts`: import `NewCustomer`, `NewProperty`.
- Modify `src/lib/labels.ts` + `src/lib/labels.test.ts`: `formatDate()`.

relay-web:
- Create `src/lib/equipment.ts` + test: `installYear`, `ageFrom`, `equipmentLabel`.
- Create `src/lib/address.ts` + test: `AddressValue`, `EMPTY_ADDRESS`, `addressStarted`.
- Create `src/lib/use-debounced.ts`: moved from `book-job-dialog.tsx`.
- Modify `src/lib/format.ts` + test: `usPhoneDigits`.
- Create `src/components/address-fields.tsx`: moved from `book-job-dialog.tsx`.
- Modify `src/components/form-field.tsx`: `focusFirstInvalid`.
- Modify `src/features/dispatch/book-job-dialog.tsx`: shared pieces, optional `customer` prop.
- Modify `src/features/dispatch/job-drawer.tsx`, `src/features/technician-jobs/job-details.tsx`: `equipmentLabel`.
- Create `src/features/customers/api.ts`, `list-params.ts` (+test), `labels.ts` (+test), `contact-dialog.tsx`, `property-dialog.tsx`, `notes-card.tsx`, `job-history.tsx`.
- Create `src/routes/customers.tsx`, `src/routes/customer.tsx`.
- Modify `src/router.tsx`, `src/components/sidebar.tsx`.

---

### Task 1: Move contact and address rules into `customers.schemas.ts`

**Files:**
- Create: `relay-api/src/modules/customers/customers.schemas.ts`
- Modify: `relay-api/src/modules/booking/booking.schemas.ts:1-17`

**Interfaces:**
- Produces: `NewCustomer`, `NewProperty` (zod objects) and `type NewProperty` from `customers.schemas.ts`.

- [ ] **Step 1: Create the branch and commit the spec and plan**

```bash
cd relay-api
git switch -c feat/customers-screen
git add docs/superpowers/specs/2026-10-03-customers-screen-design.md docs/superpowers/plans/2026-10-03-customers-screen.md
git commit -m "docs: add the customers screen spec and plan"
```

- [ ] **Step 2: Create `customers.schemas.ts` with the moved rules**

```ts
import { z } from 'zod'
import { OptionalEmail, UsPhone, UsState, Zip } from '../../lib/fields.ts'

// Contact and address rules for every way a customer is added or changed: the office's
// booking form, the customers screen and, later, spreadsheet import.

export const NewCustomer = z.object({
  name: z.string().trim().min(1, 'Enter the customer’s name').max(200),
  phone: UsPhone,
  email: OptionalEmail,
})

export const NewProperty = z.object({
  street: z.string().trim().min(1, 'Enter the street address').max(200),
  unit: z.string().trim().max(50).optional(),
  city: z.string().trim().min(1, 'Enter the city').max(100),
  state: UsState,
  zip: Zip,
})
export type NewProperty = z.infer<typeof NewProperty>
```

- [ ] **Step 3: Make booking import them**

In `relay-api/src/modules/booking/booking.schemas.ts`, replace lines 1–17 (the imports and the two local `NewCustomer` / `NewProperty` objects) with:

```ts
import { z } from 'zod'
import { SYSTEM_TYPES } from '../../db/schema.ts'
import { LocalDate } from '../../lib/fields.ts'
import { NewCustomer, NewProperty } from '../customers/customers.schemas.ts'
```

Leave `OfficeBookingInput` exactly as it is.

- [ ] **Step 4: Run the booking tests to prove nothing changed**

Run: `cd relay-api && npx vitest run src/modules/booking src/modules/online-booking`
Expected: PASS (same count as on `main`).

- [ ] **Step 5: Typecheck, lint, commit**

```bash
npm run typecheck
npx biome check --write src/modules/customers/customers.schemas.ts src/modules/booking/booking.schemas.ts
git add src/modules/customers/customers.schemas.ts src/modules/booking/booking.schemas.ts
git commit -m "refactor: keep contact and address rules in the customers module"
```

---

### Task 2: `GET /customers`: search, sort, pages and visit dates

**Files:**
- Modify: `relay-api/src/modules/customers/customers.schemas.ts` (append)
- Modify: `relay-api/src/modules/customers/customers.queries.ts`
- Modify: `relay-api/src/modules/customers/customers.service.ts` (rewrite)
- Modify: `relay-api/src/modules/customers/customers.routes.ts` (rewrite)
- Test: `relay-api/src/modules/customers/customers.test.ts` (rewrite)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `CustomerListQuery` → `{ q: string; sort: 'name' | 'newest'; page: number }`
  - `queries.listCustomers(tenantId, query, pageSize)` → `{ rows: { id, name, phone, email, lastVisitDate: string | null, nextVisitDate: string | null }[]; total: number }`
  - `queries.listProperties(tenantId, customerIds)` now also returns `equipmentBrand`, `equipmentYear`, `notes`
  - `queries.isUpcoming` (SQL boolean)
  - `service.list(tenantId, query)` → `{ customers, total, pageSize }`
  - `service.PAGE_SIZE = 25`
  - `addressesOf(customerId, properties)` (private to the service)
- Response of `GET /api/customers`: `{ customers: [{ id, name, phone, email, properties: [{ id, street, unit, city, state, zip, equipmentBrand, equipmentYear, notes }], lastVisitDate, nextVisitDate }], total, pageSize }`

- [ ] **Step 1: Write the failing tests (replace the whole test file)**

`relay-api/src/modules/customers/customers.test.ts`:

```ts
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  createJob,
  createShop,
  resetDb,
  type Shop,
  TUESDAY,
  WEDNESDAY,
} from '../../../test/helpers.ts'
import { createApp } from '../../app.ts'
import { db } from '../../db/client.ts'
import { customers } from '../../db/schema.ts'

const app = createApp()

beforeEach(resetDb)

function getAs(shop: Shop, path: string) {
  return request(app).get(path).set('Cookie', shop.cookie).expect(200)
}

// The names on one page of the list, in order.
const names = (res: request.Response) =>
  res.body.customers.map((customer: { name: string }) => customer.name)

describe('GET /api/customers', () => {
  it('lists everyone by name when nothing is typed, with their addresses', async () => {
    const shop = await createShop('desert')
    await db
      .insert(customers)
      .values({ tenantId: shop.tenant.id, name: 'Zed Young', source: 'office' })

    const res = await getAs(shop, '/api/customers')
    expect(names(res)).toEqual(['Maria Lopez', 'Zed Young'])
    expect(res.body.total).toBe(2)
    expect(res.body.pageSize).toBe(25)
    expect(res.body.customers[0]).toEqual({
      id: shop.customer.id,
      name: 'Maria Lopez',
      phone: '+16025550111',
      email: null,
      properties: [
        {
          id: shop.property.id,
          street: '12 Palm St',
          unit: null,
          city: 'Phoenix',
          state: 'AZ',
          zip: '85004',
          equipmentBrand: null,
          equipmentYear: null,
          notes: null,
        },
      ],
      lastVisitDate: null,
      nextVisitDate: null,
    })
  })

  it('finds customers by name, street, email or phone digits', async () => {
    const shop = await createShop('desert')
    await db.insert(customers).values({
      tenantId: shop.tenant.id,
      name: 'Bob Marley',
      email: 'bob@reggae.test',
      source: 'office',
    })
    const search = (q: string) => getAs(shop, `/api/customers?q=${encodeURIComponent(q)}`)

    expect(names(await search('lopez'))).toEqual(['Maria Lopez'])
    expect(names(await search('palm st'))).toEqual(['Maria Lopez'])
    expect(names(await search('reggae'))).toEqual(['Bob Marley'])
    expect(names(await search('(602) 555-01'))).toEqual(['Maria Lopez'])
    expect(names(await search('zzz'))).toEqual([])
  })

  it('sorts newest first when asked, and falls back to names for anything else', async () => {
    const shop = await createShop('desert')
    await db
      .insert(customers)
      .values({ tenantId: shop.tenant.id, name: 'Zed Young', source: 'office' })

    expect(names(await getAs(shop, '/api/customers?sort=newest'))).toEqual([
      'Zed Young',
      'Maria Lopez',
    ])
    expect(names(await getAs(shop, '/api/customers?sort=bogus&page=0'))).toEqual([
      'Maria Lopez',
      'Zed Young',
    ])
  })

  it('pages 25 at a time and counts every customer', async () => {
    const shop = await createShop('desert')
    await db.insert(customers).values(
      Array.from({ length: 25 }, (_, i) => ({
        tenantId: shop.tenant.id,
        name: `Test ${String(i).padStart(2, '0')}`,
        source: 'office' as const,
      })),
    )

    const first = await getAs(shop, '/api/customers')
    expect(first.body.customers).toHaveLength(25)
    expect(first.body.total).toBe(26)
    expect(names(await getAs(shop, '/api/customers?page=2'))).toEqual(['Test 24'])
  })

  it('shows the next upcoming visit and the last finished one', async () => {
    const shop = await createShop('desert')
    await createJob(shop, { at: `${WEDNESDAY} 08:00` }) // booked, still to come
    await createJob(shop, { at: `${TUESDAY} 08:00`, status: 'cancelled' }) // not a visit
    await createJob(shop, { at: '2020-01-07 08:00' }) // booked, but its window has passed
    await createJob(shop, {
      at: '2020-01-07 12:00',
      status: 'done',
      technicianId: shop.mike.id,
      completedAt: new Date('2020-01-07T21:00:00Z'), // 2 PM in Phoenix
    })

    const res = await getAs(shop, '/api/customers')
    expect(res.body.customers[0]).toMatchObject({
      nextVisitDate: WEDNESDAY,
      lastVisitDate: '2020-01-07',
    })
  })

  it("never returns another contractor's customers", async () => {
    const shop = await createShop('desert')
    const other = await createShop('other')
    const res = await getAs(shop, '/api/customers?q=maria')
    expect(res.body.customers.map((c: { id: string }) => c.id)).toEqual([shop.customer.id])
    expect(res.body.total).toBe(1)
    expect(JSON.stringify(res.body)).not.toContain(other.customer.id)
  })

  it('treats % and _ as plain characters', async () => {
    const shop = await createShop('desert')
    const res = await getAs(shop, '/api/customers?q=%25%25')
    expect(res.body.customers).toEqual([])
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd relay-api && npx vitest run src/modules/customers/customers.test.ts`
Expected: FAIL. The first test sees no `total` / `pageSize`, the empty search returns `[]`, and the street/email searches find nothing.

- [ ] **Step 3: Add the list query rule to `customers.schemas.ts`**

Append:

```ts
// The customer list's search box, sort and page. Anything odd falls back to the defaults.
export const CustomerListQuery = z.object({
  q: z.string().trim().max(100).default(''),
  sort: z.enum(['name', 'newest']).catch('name'),
  page: z.coerce.number().int().min(1).catch(1),
})
export type CustomerListQuery = z.infer<typeof CustomerListQuery>
```

- [ ] **Step 4: Replace `searchCustomers` and extend `listProperties` in `customers.queries.ts`**

Change the imports at the top to:

```ts
import { and, asc, desc, eq, exists, ilike, inArray, or, sql } from 'drizzle-orm'
import { type Db, db } from '../../db/client.ts'
import { customers, jobs, properties, tenants } from '../../db/schema.ts'
import type { CustomerListQuery } from './customers.schemas.ts'
```

Delete the whole `searchCustomers` function and its comment. Replace `listProperties` with:

```ts
// Every address of these customers, oldest first, with equipment and access notes.
export function listProperties(tenantId: string, customerIds: string[]) {
  if (customerIds.length === 0) return Promise.resolve([])
  return db
    .select({
      id: properties.id,
      customerId: properties.customerId,
      street: properties.street,
      unit: properties.unit,
      city: properties.city,
      state: properties.state,
      zip: properties.zip,
      equipmentBrand: properties.equipmentBrand,
      equipmentYear: properties.equipmentYear,
      notes: properties.notes,
    })
    .from(properties)
    .where(and(eq(properties.tenantId, tenantId), inArray(properties.customerId, customerIds)))
    .orderBy(asc(properties.createdAt))
}
```

Add above `escapeLike` (keep `escapeLike` as it is):

```ts
// A job that is still going to happen: booked or under way, and its arrival window hasn't
// ended. The one rule for "upcoming": the list's next visit and the record's Upcoming jobs.
export const isUpcoming = sql<boolean>`(${jobs.status} in ('booked', 'en_route', 'in_progress') and ${jobs.windowEndsAt} > now())`

// One page of customers: matching the search, by name or newest first, with the local day of
// their next upcoming visit and of their last finished one. Also counts every match.
export async function listCustomers(
  tenantId: string,
  { q, sort, page }: CustomerListQuery,
  pageSize: number,
) {
  const where = and(eq(customers.tenantId, tenantId), matching(q))
  const rows = await db
    .select({
      id: customers.id,
      name: customers.name,
      phone: customers.phone,
      email: customers.email,
      lastVisitDate: sql<string | null>`(
        select to_char(max(${jobs.completedAt}) at time zone ${tenants.timezone}, 'YYYY-MM-DD')
        from ${jobs}
        where ${jobs.customerId} = ${customers.id} and ${jobs.status} = 'done'
      )`,
      nextVisitDate: sql<string | null>`(
        select to_char(min(${jobs.windowStartsAt}) at time zone ${tenants.timezone}, 'YYYY-MM-DD')
        from ${jobs}
        where ${jobs.customerId} = ${customers.id} and ${isUpcoming}
      )`,
    })
    .from(customers)
    .innerJoin(tenants, eq(tenants.id, customers.tenantId))
    .where(where)
    .orderBy(
      ...(sort === 'newest'
        ? [desc(customers.createdAt), desc(customers.id)]
        : [asc(customers.name), asc(customers.id)]),
    )
    .limit(pageSize)
    .offset((page - 1) * pageSize)
  const total = await db.$count(customers, where)
  return { rows, total }
}

// Name, email or one of their streets contains the text, or the phone contains its digits
// (3 or more). An empty search matches everyone.
function matching(q: string) {
  if (q === '') return undefined
  const text = `%${escapeLike(q)}%`
  const digits = q.replace(/\D/g, '')
  return or(
    ilike(customers.name, text),
    ilike(customers.email, text),
    exists(
      db
        .select({ id: properties.id })
        .from(properties)
        .where(and(eq(properties.customerId, customers.id), ilike(properties.street, text))),
    ),
    digits.length >= 3 ? ilike(customers.phone, `%${digits}%`) : undefined,
  )
}
```

- [ ] **Step 5: Rewrite `customers.service.ts`**

```ts
import * as queries from './customers.queries.ts'
import type { CustomerListQuery } from './customers.schemas.ts'

// Customers on one page of the list. The web app reads it from the response.
export const PAGE_SIZE = 25

// One page of the customer list, with every customer's addresses and visit dates.
export async function list(tenantId: string, query: CustomerListQuery) {
  const { rows, total } = await queries.listCustomers(tenantId, query, PAGE_SIZE)
  const properties = await queries.listProperties(
    tenantId,
    rows.map((customer) => customer.id),
  )
  return {
    customers: rows.map((customer) => ({
      ...customer,
      properties: addressesOf(customer.id, properties),
    })),
    total,
    pageSize: PAGE_SIZE,
  }
}

// One customer's addresses out of several customers' addresses, without the customer id.
function addressesOf(
  customerId: string,
  properties: Awaited<ReturnType<typeof queries.listProperties>>,
) {
  return properties
    .filter((property) => property.customerId === customerId)
    .map(({ customerId: _, ...property }) => property)
}
```

- [ ] **Step 6: Rewrite `customers.routes.ts`**

```ts
import { Router } from 'express'
import { requireRole } from '../../middleware/auth.ts'
import { tenantOf } from '../booking/booking.service.ts'
import { CustomerListQuery } from './customers.schemas.ts'
import * as customers from './customers.service.ts'

export const customersRoutes = Router()

const staff = requireRole('owner', 'office')

customersRoutes.get('/customers', staff, async (req, res) => {
  const query = CustomerListQuery.parse(req.query)
  res.json(await customers.list(tenantOf(req.user!), query))
})
```

- [ ] **Step 7: Run the tests to see them pass**

Run: `npx vitest run src/modules/customers/customers.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 8: Typecheck, lint, commit**

```bash
npm run typecheck
npx biome check --write src/modules/customers
git add src/modules/customers
git commit -m "feat: list customers by page with search by street and email and visit dates"
```

---

### Task 3: `POST /customers`: add a customer, with an address when known

**Files:**
- Modify: `relay-api/src/modules/customers/customers.schemas.ts` (append)
- Modify: `relay-api/src/modules/customers/customers.service.ts`
- Modify: `relay-api/src/modules/customers/customers.routes.ts`
- Test: `relay-api/src/modules/customers/customers.test.ts` (append)

**Interfaces:**
- Consumes: `NewCustomer`, `NewProperty` (Task 1), `queries.insertCustomer`, `queries.insertProperty` (existing).
- Produces:
  - `NewCustomerInput` → `{ name, phone, email?, property?: NewProperty }`
  - `service.create(tenantId, input)` → `{ id: string }`
  - `propertyValues(input)` (private to the service, reused in Task 5)
- `POST /api/customers` → 201 `{ id }`.

- [ ] **Step 1: Write the failing tests**

Add to the imports of `customers.test.ts`: `eq` from `drizzle-orm`, and `properties` next to `customers` from the schema:

```ts
import { eq } from 'drizzle-orm'
import { customers, properties } from '../../db/schema.ts'
```

Append:

```ts
describe('POST /api/customers', () => {
  function postAs(shop: Shop, body: object) {
    return request(app).post('/api/customers').set('Cookie', shop.cookie).send(body)
  }

  it('adds a customer for the office, without an address', async () => {
    const shop = await createShop('desert')
    const res = await postAs(shop, { name: ' Tom Reyes ', phone: '(602) 555-0144', email: '' })
      .expect(201)

    const [saved] = await db.select().from(customers).where(eq(customers.id, res.body.id))
    expect(saved).toMatchObject({
      name: 'Tom Reyes',
      phone: '+16025550144',
      email: null,
      source: 'office',
    })
  })

  it('saves the address in the same step', async () => {
    const shop = await createShop('desert')
    const res = await postAs(shop, {
      name: 'Tom Reyes',
      phone: '6025550144',
      property: { street: '88 W Main St', unit: '', city: 'Mesa', state: 'az', zip: '85201' },
    }).expect(201)

    const saved = await db
      .select()
      .from(properties)
      .where(eq(properties.customerId, res.body.id))
    expect(saved).toEqual([
      expect.objectContaining({
        street: '88 W Main St',
        unit: null,
        city: 'Mesa',
        state: 'AZ',
        zip: '85201',
      }),
    ])
  })

  it('needs the whole address once a street is typed, and a real phone', async () => {
    const shop = await createShop('desert')
    const res = await postAs(shop, {
      name: 'Tom Reyes',
      phone: '555',
      property: { street: '88 W Main St', city: '', state: 'AZ', zip: '' },
    }).expect(400)
    expect(Object.keys(res.body.error.details).sort()).toEqual([
      'phone',
      'property.city',
      'property.zip',
    ])
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/modules/customers/customers.test.ts`
Expected: FAIL. The three new tests get `404` (no route).

- [ ] **Step 3: Add the body rule to `customers.schemas.ts`**

Append:

```ts
// The office adds a customer from the customers screen: the contact, and the address when
// they have it.
export const NewCustomerInput = NewCustomer.extend({ property: NewProperty.optional() })
export type NewCustomerInput = z.infer<typeof NewCustomerInput>
```

- [ ] **Step 4: Add `create` and `propertyValues` to `customers.service.ts`**

Change the imports to:

```ts
import { db } from '../../db/client.ts'
import * as queries from './customers.queries.ts'
import type { CustomerListQuery, NewCustomerInput, NewProperty } from './customers.schemas.ts'
```

Append:

```ts
// The office adds a customer from the customers screen, with their address when known.
export async function create(tenantId: string, input: NewCustomerInput) {
  const { property, ...contact } = input
  return db.transaction(async (tx) => {
    const customer = await queries.insertCustomer(tenantId, { ...contact, source: 'office' }, tx)
    if (property) {
      await queries.insertProperty(
        tenantId,
        { ...propertyValues(property), customerId: customer.id },
        tx,
      )
    }
    return { id: customer.id }
  })
}

type AddressFields = NewProperty & {
  equipmentBrand?: string | null
  equipmentYear?: number | null
  notes?: string | null
}

// Every saved field of an address, blanks as null. The address dialog always sends the whole
// form, so anything it leaves out is cleared.
function propertyValues(input: AddressFields) {
  return {
    street: input.street,
    unit: input.unit || null,
    city: input.city,
    state: input.state,
    zip: input.zip,
    equipmentBrand: input.equipmentBrand ?? null,
    equipmentYear: input.equipmentYear ?? null,
    notes: input.notes ?? null,
  }
}
```

- [ ] **Step 5: Add the route to `customers.routes.ts`**

Change the schema import to `import { CustomerListQuery, NewCustomerInput } from './customers.schemas.ts'` and append:

```ts
customersRoutes.post('/customers', staff, async (req, res) => {
  const input = NewCustomerInput.parse(req.body)
  res.status(201).json(await customers.create(tenantOf(req.user!), input))
})
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `npx vitest run src/modules/customers/customers.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 7: Typecheck, lint, commit**

```bash
npm run typecheck
npx biome check --write src/modules/customers
git add src/modules/customers
git commit -m "feat: let the office add a customer with an optional address"
```

---

### Task 4: `GET /customers/:customerId`: the record with job history

**Files:**
- Modify: `relay-api/src/lib/labels.ts`, `relay-api/src/lib/labels.test.ts`
- Modify: `relay-api/src/modules/customers/customers.schemas.ts` (append)
- Modify: `relay-api/src/modules/customers/customers.queries.ts`
- Modify: `relay-api/src/modules/customers/customers.service.ts`
- Modify: `relay-api/src/modules/customers/customers.routes.ts`
- Test: `relay-api/src/modules/customers/customers.test.ts` (append)

**Interfaces:**
- Consumes: `isUpcoming`, `listProperties`, `addressesOf` (Task 2); `local()` from `dispatch.queries.ts`; `formatWindow()` from `lib/labels.ts`.
- Produces:
  - `formatDate('2030-01-08')` → `'Jan 8, 2030'`
  - `CustomerParams` → `{ customerId }`
  - `queries.listJobHistory(tenantId, customerId, limit)`
  - `queries.countJobHistory(tenantId, customerId)` → `number`
  - `service.detail(tenantId, customerId)`
  - `toCustomer(row)` and `CUSTOMER_NOT_FOUND` (private to the service, reused in Task 5)
- Response: `{ customer: { id, name, phone, email, notes, source, createdAt }, properties: [...same shape as the list], jobs: [{ id, status, upcoming, propertyId, date, dateLabel, windowLabel, serviceName, problem, technicianName }], jobsTotal }`

- [ ] **Step 1: Write the failing label test**

In `relay-api/src/lib/labels.test.ts`, change the import to `import { formatClock, formatDate } from './labels.ts'` and append:

```ts
it('writes a day with its year, for history', () => {
  expect(formatDate('2030-01-08')).toBe('Jan 8, 2030')
  expect(formatDate('2026-09-12')).toBe('Sep 12, 2026')
})
```

- [ ] **Step 2: Write the failing route tests**

Append to `customers.test.ts`:

```ts
describe('GET /api/customers/:customerId', () => {
  it('returns the customer, their addresses and their jobs, upcoming first', async () => {
    const shop = await createShop('desert')
    await db
      .update(properties)
      .set({ equipmentBrand: 'Carrier', equipmentYear: 2014, notes: 'Gate 4411' })
      .where(eq(properties.id, shop.property.id))
    await createJob(shop, { at: `${WEDNESDAY} 08:00` })
    await createJob(shop, { at: `${TUESDAY} 08:00`, technicianId: shop.mike.id })
    await createJob(shop, {
      at: '2020-01-07 08:00',
      status: 'done',
      technicianId: shop.mike.id,
      completedAt: new Date('2020-01-07T18:00:00Z'),
    })
    await createJob(shop, { at: '2021-03-02 08:00', status: 'cancelled' })
    // Abandoned booking attempts are not history.
    await createJob(shop, { at: `${TUESDAY} 12:00`, status: 'held', holdExpiresAt: new Date() })
    await createJob(shop, { at: `${TUESDAY} 12:00`, status: 'expired' })

    const res = await getAs(shop, `/api/customers/${shop.customer.id}`)
    expect(res.body.customer).toEqual({
      id: shop.customer.id,
      name: 'Maria Lopez',
      phone: '+16025550111',
      email: null,
      notes: null,
      source: 'office',
      createdAt: expect.any(String),
    })
    expect(res.body.properties).toEqual([
      {
        id: shop.property.id,
        street: '12 Palm St',
        unit: null,
        city: 'Phoenix',
        state: 'AZ',
        zip: '85004',
        equipmentBrand: 'Carrier',
        equipmentYear: 2014,
        notes: 'Gate 4411',
      },
    ])
    expect(
      res.body.jobs.map((job: { date: string; status: string; upcoming: boolean }) => [
        job.date,
        job.status,
        job.upcoming,
      ]),
    ).toEqual([
      [TUESDAY, 'booked', true],
      [WEDNESDAY, 'booked', true],
      ['2021-03-02', 'cancelled', false],
      ['2020-01-07', 'done', false],
    ])
    expect(res.body.jobs[0]).toEqual({
      id: expect.any(String),
      status: 'booked',
      upcoming: true,
      propertyId: shop.property.id,
      date: TUESDAY,
      dateLabel: 'Jan 8, 2030',
      windowLabel: '8 AM–12 PM',
      serviceName: 'AC repair',
      problem: 'AC blowing warm air',
      technicianName: 'Mike',
    })
    expect(res.body.jobs[1].technicianName).toBeNull()
    expect(res.body.jobsTotal).toBe(4)
  })

  it("can't open another contractor's customer", async () => {
    const shop = await createShop('desert')
    const other = await createShop('other')
    const res = await request(app)
      .get(`/api/customers/${other.customer.id}`)
      .set('Cookie', shop.cookie)
      .expect(404)
    expect(res.body.error).toEqual({ code: 'not_found', message: 'That customer wasn’t found.' })
  })
})
```

- [ ] **Step 3: Run them to see them fail**

Run: `npx vitest run src/lib/labels.test.ts src/modules/customers/customers.test.ts`
Expected: FAIL. `formatDate` is not exported, and the record route returns 404 for both tests.

- [ ] **Step 4: Add `formatDate` to `relay-api/src/lib/labels.ts`**

Below `formatDay`, add:

```ts
const dateFormat = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
})

// '2030-01-08' → 'Jan 8, 2030'. For history, where the year matters.
export function formatDate(date: string): string {
  return dateFormat.format(new Date(`${date}T00:00:00Z`))
}
```

- [ ] **Step 5: Add the params rule to `customers.schemas.ts`**

Append:

```ts
export const CustomerParams = z.object({ customerId: z.uuid('That customer link isn’t valid') })
```

- [ ] **Step 6: Add the history queries to `customers.queries.ts`**

Change the imports to:

```ts
import { and, asc, desc, eq, exists, ilike, inArray, notInArray, or, sql } from 'drizzle-orm'
import { type Db, db } from '../../db/client.ts'
import { customers, jobs, properties, services, tenants, users } from '../../db/schema.ts'
import { local } from '../dispatch/dispatch.queries.ts'
import type { CustomerListQuery } from './customers.schemas.ts'
```

Add after `listCustomers`:

```ts
// A customer's jobs on their record: everything but abandoned booking attempts.
function inHistory(tenantId: string, customerId: string) {
  return and(
    eq(jobs.tenantId, tenantId),
    eq(jobs.customerId, customerId),
    notInArray(jobs.status, ['held', 'expired']),
  )
}

// The customer's newest `limit` jobs, newest first, with local day and window times.
export function listJobHistory(tenantId: string, customerId: string, limit: number) {
  return db
    .select({
      id: jobs.id,
      status: jobs.status,
      upcoming: isUpcoming,
      propertyId: jobs.propertyId,
      date: local(jobs.windowStartsAt, 'YYYY-MM-DD'),
      localStart: local(jobs.windowStartsAt, 'HH24:MI:SS'),
      localEnd: local(jobs.windowEndsAt, 'HH24:MI:SS'),
      serviceName: services.name,
      problem: jobs.problem,
      technicianName: users.name,
    })
    .from(jobs)
    .innerJoin(tenants, eq(tenants.id, jobs.tenantId))
    .innerJoin(services, eq(services.id, jobs.serviceId))
    .leftJoin(users, eq(users.id, jobs.technicianId))
    .where(inHistory(tenantId, customerId))
    .orderBy(desc(jobs.windowStartsAt))
    .limit(limit)
}

export function countJobHistory(tenantId: string, customerId: string) {
  return db.$count(jobs, inHistory(tenantId, customerId))
}
```

- [ ] **Step 7: Add `detail` to `customers.service.ts`**

Change the imports to:

```ts
import { db } from '../../db/client.ts'
import type { customers } from '../../db/schema.ts'
import { HttpError } from '../../lib/http-error.ts'
import { formatDate, formatWindow } from '../../lib/labels.ts'
import * as queries from './customers.queries.ts'
import type { CustomerListQuery, NewCustomerInput, NewProperty } from './customers.schemas.ts'
```

Add below `PAGE_SIZE`:

```ts
// The record page shows this many jobs; `jobsTotal` says how many there are in all.
const HISTORY_LIMIT = 100
const CUSTOMER_NOT_FOUND = 'That customer wasn’t found.'
```

Append:

```ts
// Everything on one customer's page: contact, addresses with equipment, and their jobs:
// upcoming ones first (soonest first), then past ones (newest first).
export async function detail(tenantId: string, customerId: string) {
  const customer = await queries.findCustomer(tenantId, customerId)
  if (!customer) throw new HttpError(404, 'not_found', CUSTOMER_NOT_FOUND)
  const [properties, jobs, jobsTotal] = await Promise.all([
    queries.listProperties(tenantId, [customerId]),
    queries.listJobHistory(tenantId, customerId, HISTORY_LIMIT),
    queries.countJobHistory(tenantId, customerId),
  ])
  const upcoming = jobs.filter((job) => job.upcoming).reverse()
  const past = jobs.filter((job) => !job.upcoming)
  return {
    customer: toCustomer(customer),
    properties: addressesOf(customerId, properties),
    jobs: [...upcoming, ...past].map(({ localStart, localEnd, ...job }) => ({
      ...job,
      dateLabel: formatDate(job.date),
      windowLabel: formatWindow(localStart, localEnd),
    })),
    jobsTotal,
  }
}

// What the web app sees of a customer: everything but the tenant id.
function toCustomer({ tenantId: _, ...customer }: typeof customers.$inferSelect) {
  return customer
}
```

- [ ] **Step 8: Add the route to `customers.routes.ts`**

Change the schema import to `import { CustomerListQuery, CustomerParams, NewCustomerInput } from './customers.schemas.ts'` and append:

```ts
customersRoutes.get('/customers/:customerId', staff, async (req, res) => {
  const { customerId } = CustomerParams.parse(req.params)
  res.json(await customers.detail(tenantOf(req.user!), customerId))
})
```

- [ ] **Step 9: Run the tests to see them pass**

Run: `npx vitest run src/lib/labels.test.ts src/modules/customers/customers.test.ts`
Expected: PASS.

- [ ] **Step 10: Typecheck, lint, commit**

```bash
npm run typecheck
npx biome check --write src/lib/labels.ts src/lib/labels.test.ts src/modules/customers
git add src/lib/labels.ts src/lib/labels.test.ts src/modules/customers
git commit -m "feat: show one customer with their addresses and job history"
```

---

### Task 5: Change a customer and their addresses

**Files:**
- Modify: `relay-api/src/modules/customers/customers.schemas.ts` (append)
- Modify: `relay-api/src/modules/customers/customers.queries.ts`
- Modify: `relay-api/src/modules/customers/customers.service.ts`
- Modify: `relay-api/src/modules/customers/customers.routes.ts`
- Test: `relay-api/src/modules/customers/customers.test.ts` (append)

**Interfaces:**
- Consumes: `toCustomer`, `CUSTOMER_NOT_FOUND`, `propertyValues` (Tasks 3–4); `queries.findCustomer`, `queries.insertProperty`.
- Produces:
  - `CustomerChanges` → any of `{ name, phone, email (null clears), notes (null clears) }`, at least one
  - `PropertyInput` → `NewProperty` + `{ equipmentBrand?, equipmentYear?, notes? }`
  - `PropertyParams` → `{ customerId, propertyId }`
  - `queries.updateCustomer(tenantId, customerId, changes)`
  - `queries.updateProperty(tenantId, customerId, propertyId, values)`
  - service `update`, `addProperty`, `replaceProperty`
- Routes and responses:
  - `PATCH /api/customers/:customerId` → `{ customer }`
  - `POST /api/customers/:customerId/properties` → 201 `{ property }`
  - `PUT /api/customers/:customerId/properties/:propertyId` → `{ property }`
  - `property` = `{ id, street, unit, city, state, zip, equipmentBrand, equipmentYear, notes }`

- [ ] **Step 1: Write the failing tests**

Append to `customers.test.ts`:

```ts
describe('PATCH /api/customers/:customerId', () => {
  function patchAs(shop: Shop, customerId: string, body: object) {
    return request(app)
      .patch(`/api/customers/${customerId}`)
      .set('Cookie', shop.cookie)
      .send(body)
  }

  it('changes the contact and leaves the notes alone', async () => {
    const shop = await createShop('desert')
    await db
      .update(customers)
      .set({ notes: 'Pays by check' })
      .where(eq(customers.id, shop.customer.id))

    const res = await patchAs(shop, shop.customer.id, {
      name: 'Maria L. Lopez',
      phone: '(480) 555-0199',
      email: 'Maria@Example.com',
    }).expect(200)
    expect(res.body.customer).toMatchObject({
      name: 'Maria L. Lopez',
      phone: '+14805550199',
      email: 'maria@example.com',
      notes: 'Pays by check',
    })
  })

  it('saves notes on their own, and a blank box clears them and the email', async () => {
    const shop = await createShop('desert')
    const saved = await patchAs(shop, shop.customer.id, {
      notes: 'Prefers mornings\nDog in yard',
    }).expect(200)
    expect(saved.body.customer).toMatchObject({
      notes: 'Prefers mornings\nDog in yard',
      phone: '+16025550111',
    })

    const cleared = await patchAs(shop, shop.customer.id, { notes: '   ', email: '' }).expect(200)
    expect(cleared.body.customer).toMatchObject({ notes: null, email: null })
  })

  it('refuses long notes, a bad email and an empty change', async () => {
    const shop = await createShop('desert')
    const long = await patchAs(shop, shop.customer.id, { notes: 'x'.repeat(2001) }).expect(400)
    expect(long.body.error.details.notes).toEqual(['Keep the notes under 2,000 characters'])
    const email = await patchAs(shop, shop.customer.id, { email: 'not-an-email' }).expect(400)
    expect(email.body.error.details.email).toEqual(['Enter a valid email address'])
    await patchAs(shop, shop.customer.id, {}).expect(400)
  })

  it("can't change another contractor's customer", async () => {
    const shop = await createShop('desert')
    const other = await createShop('other')
    await patchAs(shop, other.customer.id, { notes: 'hi' }).expect(404)
  })
})

describe('customer addresses', () => {
  const address = { street: '12 Palm St', city: 'Phoenix', state: 'AZ', zip: '85004' }

  function putAs(shop: Shop, customerId: string, propertyId: string, body: object) {
    return request(app)
      .put(`/api/customers/${customerId}/properties/${propertyId}`)
      .set('Cookie', shop.cookie)
      .send(body)
  }

  it('adds an address with its equipment', async () => {
    const shop = await createShop('desert')
    const res = await request(app)
      .post(`/api/customers/${shop.customer.id}/properties`)
      .set('Cookie', shop.cookie)
      .send({
        street: '88 W Main St',
        unit: '',
        city: 'Mesa',
        state: 'AZ',
        zip: '85201',
        equipmentBrand: 'Trane',
        equipmentYear: 2016,
        notes: 'Side gate',
      })
      .expect(201)
    expect(res.body.property).toEqual({
      id: expect.any(String),
      street: '88 W Main St',
      unit: null,
      city: 'Mesa',
      state: 'AZ',
      zip: '85201',
      equipmentBrand: 'Trane',
      equipmentYear: 2016,
      notes: 'Side gate',
    })
  })

  it('replaces an address, clearing what the form left empty', async () => {
    const shop = await createShop('desert')
    await db
      .update(properties)
      .set({ unit: '4', equipmentBrand: 'Carrier', equipmentYear: 2014, notes: 'Gate 4411' })
      .where(eq(properties.id, shop.property.id))

    const res = await putAs(shop, shop.customer.id, shop.property.id, {
      ...address,
      street: '12 Palm Street',
      equipmentBrand: '',
      equipmentYear: null,
      notes: '',
    }).expect(200)
    expect(res.body.property).toEqual({
      id: shop.property.id,
      street: '12 Palm Street',
      unit: null,
      city: 'Phoenix',
      state: 'AZ',
      zip: '85004',
      equipmentBrand: null,
      equipmentYear: null,
      notes: null,
    })
  })

  it('refuses an install year before 1950, in the future or not whole', async () => {
    const shop = await createShop('desert')
    for (const equipmentYear of [1949, new Date().getFullYear() + 1, 2000.5]) {
      const res = await putAs(shop, shop.customer.id, shop.property.id, {
        ...address,
        equipmentYear,
      }).expect(400)
      expect(res.body.error.details.equipmentYear).toEqual(['Check the equipment age'])
    }
  })

  it("won't touch another customer's address or another contractor's customer", async () => {
    const shop = await createShop('desert')
    const other = await createShop('other')
    const [bob] = await db
      .insert(customers)
      .values({ tenantId: shop.tenant.id, name: 'Bob Marley', source: 'office' })
      .returning()

    const res = await putAs(shop, bob.id, shop.property.id, address).expect(404)
    expect(res.body.error.message).toBe('That address wasn’t found for this customer.')
    await request(app)
      .post(`/api/customers/${other.customer.id}/properties`)
      .set('Cookie', shop.cookie)
      .send(address)
      .expect(404)
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/modules/customers/customers.test.ts`
Expected: FAIL. The new tests get 404 (no routes).

- [ ] **Step 3: Add the rules to `customers.schemas.ts`**

Append:

```ts
// A blank box saves as nothing (null); a field left out isn't touched (undefined).
function blankToNull(value: unknown) {
  return typeof value === 'string' && value.trim() === '' ? null : value
}

function optionalText(max: number, message: string) {
  return z.preprocess(blankToNull, z.string().trim().max(max, message).nullish())
}

// Changing a customer: the contact dialog sends name, phone and email; the notes card sends
// notes. A blank email or notes box clears it.
export const CustomerChanges = z
  .object({
    name: NewCustomer.shape.name.optional(),
    phone: UsPhone.optional(),
    email: z.preprocess(
      blankToNull,
      z.email('Enter a valid email address').trim().toLowerCase().nullish(),
    ),
    notes: optionalText(2000, 'Keep the notes under 2,000 characters'),
  })
  .refine(
    (changes) => Object.values(changes).some((value) => value !== undefined),
    'Nothing to save',
  )
export type CustomerChanges = z.infer<typeof CustomerChanges>

// The address dialog: the address, its equipment and access notes, always the whole form.
// The equipment's age is saved as its install year, so it grows older on its own.
export const PropertyInput = NewProperty.extend({
  equipmentBrand: optionalText(50, 'Keep the brand under 50 characters'),
  equipmentYear: z
    .number('Check the equipment age')
    .int('Check the equipment age')
    .min(1950, 'Check the equipment age')
    .refine((year) => year <= new Date().getFullYear(), 'Check the equipment age')
    .nullish(),
  notes: optionalText(1000, 'Keep the access notes under 1,000 characters'),
})
export type PropertyInput = z.infer<typeof PropertyInput>

export const PropertyParams = CustomerParams.extend({
  propertyId: z.uuid('That address link isn’t valid'),
})
```

- [ ] **Step 4: Add the update queries to `customers.queries.ts`**

Append:

```ts
// Fields left undefined are not changed.
export async function updateCustomer(
  tenantId: string,
  customerId: string,
  changes: Partial<Pick<typeof customers.$inferInsert, 'name' | 'phone' | 'email' | 'notes'>>,
) {
  const [customer] = await db
    .update(customers)
    .set(changes)
    .where(and(eq(customers.tenantId, tenantId), eq(customers.id, customerId)))
    .returning()
  return customer
}

// Only this customer's address: another customer's address id changes nothing.
export async function updateProperty(
  tenantId: string,
  customerId: string,
  propertyId: string,
  values: Omit<typeof properties.$inferInsert, 'tenantId' | 'customerId'>,
) {
  const [property] = await db
    .update(properties)
    .set(values)
    .where(
      and(
        eq(properties.tenantId, tenantId),
        eq(properties.customerId, customerId),
        eq(properties.id, propertyId),
      ),
    )
    .returning()
  return property
}
```

- [ ] **Step 5: Add the service functions to `customers.service.ts`**

Change the two type imports to:

```ts
import type { customers, properties } from '../../db/schema.ts'
import type {
  CustomerChanges,
  CustomerListQuery,
  NewCustomerInput,
  NewProperty,
  PropertyInput,
} from './customers.schemas.ts'
```

Add below `CUSTOMER_NOT_FOUND`:

```ts
const PROPERTY_NOT_FOUND = 'That address wasn’t found for this customer.'
```

Append:

```ts
// Changes the contact (name, phone, email) or the notes. Fields not sent stay as they are.
export async function update(tenantId: string, customerId: string, changes: CustomerChanges) {
  const customer = await queries.updateCustomer(tenantId, customerId, changes)
  if (!customer) throw new HttpError(404, 'not_found', CUSTOMER_NOT_FOUND)
  return { customer: toCustomer(customer) }
}

export async function addProperty(tenantId: string, customerId: string, input: PropertyInput) {
  if (!(await queries.findCustomer(tenantId, customerId))) {
    throw new HttpError(404, 'not_found', CUSTOMER_NOT_FOUND)
  }
  const property = await queries.insertProperty(tenantId, {
    ...propertyValues(input),
    customerId,
  })
  return { property: toProperty(property) }
}

export async function replaceProperty(
  tenantId: string,
  customerId: string,
  propertyId: string,
  input: PropertyInput,
) {
  const property = await queries.updateProperty(
    tenantId,
    customerId,
    propertyId,
    propertyValues(input),
  )
  if (!property) throw new HttpError(404, 'not_found', PROPERTY_NOT_FOUND)
  return { property: toProperty(property) }
}

// What the web app sees of an address: no tenant, customer or creation time.
function toProperty({
  tenantId: _tenant,
  customerId: _customer,
  createdAt: _created,
  ...property
}: typeof properties.$inferSelect) {
  return property
}
```

- [ ] **Step 6: Add the routes to `customers.routes.ts`**

Change the schema import to:

```ts
import {
  CustomerChanges,
  CustomerListQuery,
  CustomerParams,
  NewCustomerInput,
  PropertyInput,
  PropertyParams,
} from './customers.schemas.ts'
```

Append:

```ts
customersRoutes.patch('/customers/:customerId', staff, async (req, res) => {
  const { customerId } = CustomerParams.parse(req.params)
  const changes = CustomerChanges.parse(req.body)
  res.json(await customers.update(tenantOf(req.user!), customerId, changes))
})

customersRoutes.post('/customers/:customerId/properties', staff, async (req, res) => {
  const { customerId } = CustomerParams.parse(req.params)
  const input = PropertyInput.parse(req.body)
  res.status(201).json(await customers.addProperty(tenantOf(req.user!), customerId, input))
})

customersRoutes.put('/customers/:customerId/properties/:propertyId', staff, async (req, res) => {
  const { customerId, propertyId } = PropertyParams.parse(req.params)
  const input = PropertyInput.parse(req.body)
  res.json(await customers.replaceProperty(tenantOf(req.user!), customerId, propertyId, input))
})
```

- [ ] **Step 7: Run the whole API suite**

Run: `npx vitest run`
Expected: PASS, including booking, online booking and dispatch (they share the customer queries and the moved schemas).

- [ ] **Step 8: Typecheck, lint, commit**

```bash
npm run typecheck
npx biome check --write src/modules/customers
git add src/modules/customers
git commit -m "feat: let the office change a customer's contact, notes and addresses"
```

---

### Task 6: One way to word equipment (relay-web)

**Files:**
- Create: `relay-web/src/lib/equipment.ts`, `relay-web/src/lib/equipment.test.ts`
- Modify: `relay-web/src/features/dispatch/job-drawer.tsx:54-58,112-117`
- Modify: `relay-web/src/features/technician-jobs/job-details.tsx:98-112`

**Interfaces:**
- Produces:
  - `installYear(age: number, today = new Date()): number`
  - `ageFrom(year: number, today = new Date()): number`
  - `equipmentLabel(brand: string | null, year: number | null, today = new Date()): string | null`

- [ ] **Step 1: Create the branch**

```bash
cd relay-web
git switch -c feat/customers-screen
```

- [ ] **Step 2: Write the failing test**

`relay-web/src/lib/equipment.test.ts`:

```ts
import { expect, it } from 'vitest'
import { ageFrom, equipmentLabel, installYear } from './equipment'

const today = new Date(2026, 9, 3) // Oct 3, 2026

it('turns a typed age into an install year and back', () => {
  expect(installYear(12, today)).toBe(2014)
  expect(installYear(0, today)).toBe(2026)
  expect(ageFrom(2014, today)).toBe(12)
})

it('words equipment the same way everywhere', () => {
  expect(equipmentLabel('Carrier', 2014, today)).toBe('Carrier · about 12 years old')
  expect(equipmentLabel('Carrier', 2026, today)).toBe('Carrier · less than a year old')
  expect(equipmentLabel('Carrier', 2025, today)).toBe('Carrier · about 1 year old')
  expect(equipmentLabel('Carrier', null, today)).toBe('Carrier')
  expect(equipmentLabel(null, 2014, today)).toBe('About 12 years old')
  expect(equipmentLabel(null, null, today)).toBeNull()
})
```

- [ ] **Step 3: Run it to see it fail**

Run: `npx vitest run src/lib/equipment.test.ts`
Expected: FAIL with "Failed to resolve import './equipment'".

- [ ] **Step 4: Write `relay-web/src/lib/equipment.ts`**

```ts
// relay-api saves equipment age as an install year, so it grows older on its own. The office
// types an approximate age; these turn one into the other and into words.

// About 12 years old in 2026 → installed 2014.
export function installYear(age: number, today = new Date()): number {
  return today.getFullYear() - age
}

// Installed 2014 → 12 years old in 2026.
export function ageFrom(year: number, today = new Date()): number {
  return today.getFullYear() - year
}

// 'Carrier · about 12 years old', 'Carrier', 'About 12 years old', or null when nothing is
// saved. The customer record, the job drawer and the technician page all use it.
export function equipmentLabel(
  brand: string | null,
  year: number | null,
  today = new Date(),
): string | null {
  const age = year === null ? null : ageWords(ageFrom(year, today))
  if (brand && age) return `${brand} · ${age}`
  if (brand) return brand
  if (age) return age.charAt(0).toUpperCase() + age.slice(1)
  return null
}

function ageWords(age: number): string {
  if (age <= 0) return 'less than a year old'
  if (age === 1) return 'about 1 year old'
  return `about ${age} years old`
}
```

- [ ] **Step 5: Run it to see it pass**

Run: `npx vitest run src/lib/equipment.test.ts`
Expected: PASS.

- [ ] **Step 6: Use it in the job drawer**

In `relay-web/src/features/dispatch/job-drawer.tsx`, add `import { equipmentLabel } from '@/lib/equipment'` to the imports. In `JobDetails`, right after `const { customer, property } = job`, add:

```ts
  const equipment = equipmentLabel(property.equipmentBrand, property.equipmentYear)
```

Replace:

```tsx
          {property.equipmentBrand && (
            <p className="text-muted-foreground">
              Equipment: {property.equipmentBrand}
              {property.equipmentYear && `, installed about ${property.equipmentYear}`}
            </p>
          )}
```

with:

```tsx
          {equipment && <p className="text-muted-foreground">Equipment: {equipment}</p>}
```

- [ ] **Step 7: Use it on the technician job page**

In `relay-web/src/features/technician-jobs/job-details.tsx`, add `import { equipmentLabel } from '@/lib/equipment'`. In `JobInfo`, after `const { property } = job`, add:

```ts
  const equipment = equipmentLabel(property.equipmentBrand, property.equipmentYear)
```

Replace:

```tsx
          {property.equipmentBrand && (
            <p>
              Equipment: {property.equipmentBrand}
              {property.equipmentYear && `, installed about ${property.equipmentYear}`}
            </p>
          )}
```

with:

```tsx
          {equipment && <p>Equipment: {equipment}</p>}
```

- [ ] **Step 8: Typecheck, lint, commit**

```bash
npm run typecheck
npx biome check --write src/lib/equipment.ts src/lib/equipment.test.ts src/features/dispatch/job-drawer.tsx src/features/technician-jobs/job-details.tsx
git add src/lib/equipment.ts src/lib/equipment.test.ts src/features/dispatch/job-drawer.tsx src/features/technician-jobs/job-details.tsx
git commit -m "feat: word equipment age the same way everywhere"
```

---

### Task 7: Shared form pieces, and "Book job" for a picked customer

**Files:**
- Create: `relay-web/src/lib/use-debounced.ts`
- Create: `relay-web/src/lib/address.ts`, `relay-web/src/lib/address.test.ts`
- Modify: `relay-web/src/lib/format.ts`, `relay-web/src/lib/format.test.ts`
- Create: `relay-web/src/components/address-fields.tsx`
- Modify: `relay-web/src/components/form-field.tsx`
- Modify: `relay-web/src/features/dispatch/book-job-dialog.tsx`

**Interfaces:**
- Produces:
  - `useDebounced<T>(value: T, delayMs: number): T`
  - `type AddressValue = { street; unit; city; state; zip }` (all strings)
  - `EMPTY_ADDRESS`
  - `addressStarted(address: AddressValue): boolean`
  - `usPhoneDigits(value: string): string | null`
  - `<AddressFields idPrefix errorPrefix value errors onChange />`, where `errorPrefix` is `'newProperty'`, `'property'` or `''`
  - `focusFirstInvalid(form: HTMLFormElement | null): void`
  - `BookJobDialog` accepts an optional `customer?: CustomerMatch`

- [ ] **Step 1: Write the failing tests**

`relay-web/src/lib/address.test.ts`:

```ts
import { expect, it } from 'vitest'
import { addressStarted, EMPTY_ADDRESS } from './address'

it('counts an address as started once anything but the pre-filled state is typed', () => {
  expect(addressStarted(EMPTY_ADDRESS)).toBe(false)
  expect(addressStarted({ ...EMPTY_ADDRESS, state: 'TX' })).toBe(false)
  expect(addressStarted({ ...EMPTY_ADDRESS, street: '  ' })).toBe(false)
  expect(addressStarted({ ...EMPTY_ADDRESS, street: '12 Palm St' })).toBe(true)
  expect(addressStarted({ ...EMPTY_ADDRESS, zip: '85004' })).toBe(true)
})
```

In `relay-web/src/lib/format.test.ts`, change the import to `import { formatMoney, initials, usPhoneDigits } from './format'` and append:

```ts
it('finds the 10 digits of a US phone number once they are all typed', () => {
  expect(usPhoneDigits('(480) 555-0199')).toBe('4805550199')
  expect(usPhoneDigits('+1 480 555 0199')).toBe('4805550199')
  expect(usPhoneDigits('480 555')).toBeNull()
  expect(usPhoneDigits('')).toBeNull()
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/lib/address.test.ts src/lib/format.test.ts`
Expected: FAIL. `./address` doesn't resolve and `usPhoneDigits` is not exported.

- [ ] **Step 3: Write `relay-web/src/lib/address.ts`**

```ts
export type AddressValue = { street: string; unit: string; city: string; state: string; zip: string }

// A blank address form. The pilot shops are in Arizona.
export const EMPTY_ADDRESS: AddressValue = { street: '', unit: '', city: '', state: 'AZ', zip: '' }

// True once anything but the pre-filled state is typed. A started address must be finished:
// relay-api then asks for the missing parts.
export function addressStarted(address: AddressValue): boolean {
  return [address.street, address.unit, address.city, address.zip].some(
    (part) => part.trim() !== '',
  )
}
```

- [ ] **Step 4: Add `usPhoneDigits` to `relay-web/src/lib/format.ts`**

Append:

```ts
// The 10 digits of a US phone number as typed, or null until all 10 are there.
// '(480) 555-0199' → '4805550199', '+1 480 555 0199' → '4805550199'.
export function usPhoneDigits(value: string): string | null {
  const digits = value.replace(/\D/g, '')
  const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits
  return national.length === 10 ? national : null
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `npx vitest run src/lib/address.test.ts src/lib/format.test.ts`
Expected: PASS.

- [ ] **Step 6: Move `useDebounced` to `relay-web/src/lib/use-debounced.ts`**

```ts
import { useEffect, useState } from 'react'

// `value`, once it has stopped changing for `delayMs`. For search boxes that ask the API as
// people type.
export function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])
  return debounced
}
```

- [ ] **Step 7: Add `focusFirstInvalid` to `relay-web/src/components/form-field.tsx`**

Append:

```ts
// After a refused save, put the cursor in the first field the API flagged. Call it after the
// errors are on screen (for example right after `flushSync(() => setFieldErrors(...))`).
export function focusFirstInvalid(form: HTMLFormElement | null) {
  form?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
}
```

- [ ] **Step 8: Create `relay-web/src/components/address-fields.tsx` (moved from the book-job dialog)**

```tsx
import { Field, type FieldErrors } from '@/components/form-field'
import { Input } from '@/components/ui/input'
import type { AddressValue } from '@/lib/address'

// Street, unit, city, state and ZIP. `idPrefix` keeps ids unique per form. `errorPrefix` is
// where relay-api puts this address's errors: 'newProperty' (booking), 'property' (add
// customer) or '' (the address dialog, whose fields are at the top level).
export function AddressFields({
  idPrefix,
  errorPrefix,
  value,
  errors,
  onChange,
}: {
  idPrefix: string
  errorPrefix: string
  value: AddressValue
  errors: FieldErrors
  onChange: (value: AddressValue) => void
}) {
  const set = (key: keyof AddressValue) => (event: { target: { value: string } }) =>
    onChange({ ...value, [key]: event.target.value })
  const errorsFor = (key: keyof AddressValue) => errors[errorPrefix ? `${errorPrefix}.${key}` : key]
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-[1fr_6rem] gap-3">
        <Field id={`${idPrefix}-street`} label="Street address" errors={errorsFor('street')}>
          <Input id={`${idPrefix}-street`} value={value.street} onChange={set('street')} />
        </Field>
        <Field id={`${idPrefix}-unit`} label="Unit" errors={errorsFor('unit')}>
          <Input id={`${idPrefix}-unit`} value={value.unit} onChange={set('unit')} />
        </Field>
      </div>
      <div className="grid grid-cols-[1fr_4rem_6rem] gap-3">
        <Field id={`${idPrefix}-city`} label="City" errors={errorsFor('city')}>
          <Input id={`${idPrefix}-city`} value={value.city} onChange={set('city')} />
        </Field>
        <Field id={`${idPrefix}-state`} label="State" errors={errorsFor('state')}>
          <Input
            id={`${idPrefix}-state`}
            maxLength={2}
            value={value.state}
            onChange={set('state')}
          />
        </Field>
        <Field id={`${idPrefix}-zip`} label="ZIP" errors={errorsFor('zip')}>
          <Input
            id={`${idPrefix}-zip`}
            inputMode="numeric"
            maxLength={5}
            value={value.zip}
            onChange={set('zip')}
          />
        </Field>
      </div>
    </div>
  )
}
```

- [ ] **Step 9: Point the book-job dialog at the shared pieces and add the `customer` prop**

In `relay-web/src/features/dispatch/book-job-dialog.tsx`:

1. Change `import { useEffect, useState } from 'react'` to `import { useState } from 'react'`, and add:

```ts
import { AddressFields } from '@/components/address-fields'
import { EMPTY_ADDRESS } from '@/lib/address'
import { useDebounced } from '@/lib/use-debounced'
```

2. Delete the line `const EMPTY_PROPERTY = { street: '', unit: '', city: '', state: 'AZ', zip: '' }`. Replace both uses of `EMPTY_PROPERTY` (in `useState(EMPTY_PROPERTY)` and anywhere else) with `EMPTY_ADDRESS`.

3. Give `BookJobDialog` the prop and pass it down:

```tsx
// The office books a job for a caller. Opens on the day the board shows, or, from a
// customer's page, with that customer and their first address already picked.
export function BookJobDialog({
  open,
  defaultDate,
  customer,
  onClose,
  onBooked,
}: {
  open: boolean
  defaultDate: string
  customer?: CustomerMatch
  onClose: () => void
  onBooked: (jobId: string, date: string) => void
}) {
```

and in its body change the form line to:

```tsx
        {open && (
          <BookJobForm
            defaultDate={defaultDate}
            initialCustomer={customer ?? null}
            onClose={onClose}
            onBooked={onBooked}
          />
        )}
```

4. In `BookJobForm`, add `initialCustomer` to the props (`initialCustomer: CustomerMatch | null` in the type, destructured next to `defaultDate`) and change the first `useState` lines to:

```ts
  const [customer, setCustomer] = useState<CustomerMatch | null>(initialCustomer)
  const [addingCustomer, setAddingCustomer] = useState(false)
  const [newCustomer, setNewCustomer] = useState(EMPTY_CUSTOMER)
  const [propertyId, setPropertyId] = useState<string>(initialCustomer?.properties[0]?.id ?? 'new')
  const [newProperty, setNewProperty] = useState(EMPTY_ADDRESS)
```

5. Replace the `NewPropertyFields` usage:

```tsx
          <NewPropertyFields value={newProperty} errors={fieldErrors} onChange={setNewProperty} />
```

with:

```tsx
          <>
            <AddressFields
              idPrefix="book"
              errorPrefix="newProperty"
              value={newProperty}
              errors={fieldErrors}
              onChange={setNewProperty}
            />
            {fieldErrors.propertyId && <FieldMessages messages={fieldErrors.propertyId} />}
          </>
```

6. Delete the `NewPropertyFields` function and the `useDebounced` function at the bottom of the file.

- [ ] **Step 10: Run all web tests and the typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 11: Check the dispatch board's booking by hand**

Run relay-api (`npm run dev` in `relay-api`) and relay-web (`npm run dev` in `relay-web`). Sign in as the office user and open Dispatch → Book a job → Add a new customer. Submit with an empty street. Expected: "Enter the street address" under Street address, exactly as before.

- [ ] **Step 12: Lint, commit**

```bash
npx biome check --write src/lib src/components/address-fields.tsx src/components/form-field.tsx src/features/dispatch/book-job-dialog.tsx
git add src/lib src/components/address-fields.tsx src/components/form-field.tsx src/features/dispatch/book-job-dialog.tsx
git commit -m "refactor: share the address fields and let booking start with a picked customer"
```

---

### Task 8: Customers API hooks, URL state and wording

**Files:**
- Create: `relay-web/src/features/customers/api.ts`
- Create: `relay-web/src/features/customers/list-params.ts`, `list-params.test.ts`
- Create: `relay-web/src/features/customers/labels.ts`, `labels.test.ts`

**Interfaces:**
- Consumes: `JOB_STATUSES` from `features/dispatch/api`; `AddressValue`, `usPhoneDigits` (Task 7).
- Produces:
  - `type ListParams = { q: string; sort: Sort; page: number }`, `type Sort = 'name' | 'newest'`
  - `readListParams(params: URLSearchParams): ListParams`
  - `listSearch(params: ListParams): string`
  - `visitLabel(customer: { nextVisitDate; lastVisitDate }): string`
  - `countLabel(total: number, searching: boolean): string`
  - `rangeLabel(page: number, pageSize: number, total: number): string`
  - `sinceLabel(createdAt: string): string`
  - `SOURCE_LABELS: Record<CustomerSource, string>`
  - types: `CustomerSource`, `CustomerProperty`, `ListedCustomer`, `HistoryJob`, `CustomerRecord`, `NewCustomerInput`, `CustomerChanges`, `PropertyInput`
  - `customerKey(id)`
  - hooks: `useCustomers(params)`, `useCustomer(id)`, `usePhoneTwins(phone, exceptId?)`, `useCreateCustomer()`, `useUpdateCustomer()`, `useSaveProperty(customerId)`

- [ ] **Step 1: Write the failing tests**

`relay-web/src/features/customers/list-params.test.ts`:

```ts
import { expect, it } from 'vitest'
import { listSearch, readListParams } from './list-params'

const read = (search: string) => readListParams(new URLSearchParams(search))

it('reads the search, sort and page from the URL', () => {
  expect(read('q=elm&sort=newest&page=2')).toEqual({ q: 'elm', sort: 'newest', page: 2 })
})

it('falls back to the defaults for anything missing or odd', () => {
  expect(read('')).toEqual({ q: '', sort: 'name', page: 1 })
  expect(read('q=%20%20&sort=bogus&page=0')).toEqual({ q: '', sort: 'name', page: 1 })
  expect(read('page=abc')).toEqual({ q: '', sort: 'name', page: 1 })
  expect(read('page=1.5')).toEqual({ q: '', sort: 'name', page: 1 })
})

it('writes only what differs from the defaults', () => {
  expect(listSearch({ q: '', sort: 'name', page: 1 })).toBe('')
  expect(listSearch({ q: 'elm st', sort: 'newest', page: 3 })).toBe('q=elm+st&sort=newest&page=3')
})
```

`relay-web/src/features/customers/labels.test.ts`:

```ts
import { expect, it } from 'vitest'
import { countLabel, rangeLabel, sinceLabel, visitLabel } from './labels'

it('prefers the next visit, then the last one', () => {
  expect(visitLabel({ nextVisitDate: '2026-10-05', lastVisitDate: '2026-09-12' })).toBe(
    'Next Oct 5',
  )
  expect(visitLabel({ nextVisitDate: null, lastVisitDate: '2026-09-12' })).toBe(
    'Last visit Sep 12, 2026',
  )
  expect(visitLabel({ nextVisitDate: null, lastVisitDate: null })).toBe('No visits yet')
})

it('counts customers, or matches while searching', () => {
  expect(countLabel(1240, false)).toBe('1,240 customers')
  expect(countLabel(1, false)).toBe('1 customer')
  expect(countLabel(3, true)).toBe('3 matches')
  expect(countLabel(1, true)).toBe('1 match')
})

it('says which customers this page shows', () => {
  expect(rangeLabel(1, 25, 1240)).toBe('Showing 1–25 of 1,240')
  expect(rangeLabel(2, 25, 40)).toBe('Showing 26–40 of 40')
})

it('says since when they are a customer', () => {
  expect(sinceLabel('2025-03-15T12:00:00.000Z')).toBe('Customer since Mar 2025')
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/features/customers`
Expected: FAIL. `./list-params` and `./labels` don't resolve.

- [ ] **Step 3: Write `relay-web/src/features/customers/list-params.ts`**

```ts
// The customer list's search, sort and page live in the URL (`/customers?q=elm&page=2`), so
// Back from a customer returns to the same spot and the link can be shared.

export const SORTS = ['name', 'newest'] as const
export type Sort = (typeof SORTS)[number]
export type ListParams = { q: string; sort: Sort; page: number }

// Anything missing or odd falls back: no search, by name, page 1.
export function readListParams(params: URLSearchParams): ListParams {
  const page = Number(params.get('page'))
  return {
    q: (params.get('q') ?? '').trim().slice(0, 100),
    sort: params.get('sort') === 'newest' ? 'newest' : 'name',
    page: Number.isInteger(page) && page >= 1 ? page : 1,
  }
}

// Only what differs from the defaults, so the plain list keeps the plain URL '/customers'.
// relay-api reads the same keys.
export function listSearch({ q, sort, page }: ListParams): string {
  const params = new URLSearchParams()
  if (q) params.set('q', q)
  if (sort !== 'name') params.set('sort', sort)
  if (page > 1) params.set('page', String(page))
  return params.toString()
}
```

- [ ] **Step 4: Write `relay-web/src/features/customers/api.ts`**

```ts
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { JOB_STATUSES } from '@/features/dispatch/api'
import type { AddressValue } from '@/lib/address'
import { api } from '@/lib/api'
import { usPhoneDigits } from '@/lib/format'
import { type ListParams, listSearch } from './list-params'

export const CUSTOMER_SOURCES = ['booking', 'call', 'office', 'import'] as const
export type CustomerSource = (typeof CUSTOMER_SOURCES)[number]

const Property = z.object({
  id: z.string(),
  street: z.string(),
  unit: z.string().nullable(),
  city: z.string(),
  state: z.string(),
  zip: z.string(),
  equipmentBrand: z.string().nullable(),
  equipmentYear: z.number().nullable(), // install year; see lib/equipment.ts
  notes: z.string().nullable(), // access notes: gate code, dog, attic
})
export type CustomerProperty = z.infer<typeof Property>

const ListedCustomer = z.object({
  id: z.string(),
  name: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  properties: z.array(Property),
  lastVisitDate: z.string().nullable(), // local day, '2026-09-12'
  nextVisitDate: z.string().nullable(),
})
export type ListedCustomer = z.infer<typeof ListedCustomer>

const CustomerPage = z.object({
  customers: z.array(ListedCustomer),
  total: z.number(),
  pageSize: z.number(),
})

const Customer = z.object({
  id: z.string(),
  name: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  notes: z.string().nullable(),
  source: z.enum(CUSTOMER_SOURCES),
  createdAt: z.string(),
})

const HistoryJob = z.object({
  id: z.string(),
  status: z.enum(JOB_STATUSES),
  upcoming: z.boolean(),
  propertyId: z.string(),
  date: z.string(),
  dateLabel: z.string(), // 'Oct 5, 2026'
  windowLabel: z.string(), // '8 AM–12 PM'
  serviceName: z.string(),
  problem: z.string(),
  technicianName: z.string().nullable(),
})
export type HistoryJob = z.infer<typeof HistoryJob>

const CustomerRecord = z.object({
  customer: Customer,
  properties: z.array(Property),
  jobs: z.array(HistoryJob), // upcoming first, then past, at most 100
  jobsTotal: z.number(),
})
export type CustomerRecord = z.infer<typeof CustomerRecord>

const Created = z.object({ id: z.string() })
const SavedCustomer = z.object({ customer: Customer })
const SavedProperty = z.object({ property: Property })

export type NewCustomerInput = {
  name: string
  phone: string
  email: string
  property?: AddressValue
}
export type CustomerChanges = { name?: string; phone?: string; email?: string; notes?: string }
export type PropertyInput = AddressValue & {
  equipmentBrand: string
  equipmentYear: number | null
  notes: string
}

export const customerKey = (customerId: string) => ['customers', 'record', customerId]

// One page of the list. The previous page stays on screen while the next one loads.
export function useCustomers(params: ListParams) {
  return useQuery({
    queryKey: ['customers', 'list', params],
    queryFn: () => api.get(`/customers?${listSearch(params)}`, CustomerPage),
    placeholderData: keepPreviousData,
  })
}

export function useCustomer(customerId: string) {
  return useQuery({
    queryKey: customerKey(customerId),
    queryFn: () => api.get(`/customers/${customerId}`, CustomerRecord),
  })
}

// Other customers already using this phone number, once all 10 digits are typed.
// `exceptId` is the customer being edited, who doesn't count.
export function usePhoneTwins(phone: string, exceptId?: string) {
  const digits = usPhoneDigits(phone)
  return useQuery({
    queryKey: ['customers', 'phone', digits],
    queryFn: () => api.get(`/customers?q=${digits}`, CustomerPage),
    enabled: digits !== null,
    select: (data) =>
      data.customers.filter(
        (customer) => customer.phone === `+1${digits}` && customer.id !== exceptId,
      ),
  })
}

// Customer changes show here, in the book-job search and in open job drawers.
function useRefreshCustomers() {
  const queryClient = useQueryClient()
  return () => {
    queryClient.invalidateQueries({ queryKey: ['customers'] })
    queryClient.invalidateQueries({ queryKey: ['dispatch'] })
  }
}

export function useCreateCustomer() {
  const refresh = useRefreshCustomers()
  return useMutation({
    mutationFn: (input: NewCustomerInput) => api.post('/customers', input, Created),
    onSuccess: refresh,
  })
}

// The contact dialog sends name, phone and email; the notes card sends notes.
export function useUpdateCustomer() {
  const refresh = useRefreshCustomers()
  return useMutation({
    mutationFn: ({ id, ...changes }: CustomerChanges & { id: string }) =>
      api.patch(`/customers/${id}`, changes, SavedCustomer),
    onSuccess: refresh,
  })
}

// Adds an address (no `id`) or replaces one.
export function useSaveProperty(customerId: string) {
  const refresh = useRefreshCustomers()
  return useMutation({
    mutationFn: ({ id, ...input }: PropertyInput & { id?: string }) =>
      id
        ? api.put(`/customers/${customerId}/properties/${id}`, input, SavedProperty)
        : api.post(`/customers/${customerId}/properties`, input, SavedProperty),
    onSuccess: refresh,
  })
}
```

- [ ] **Step 5: Write `relay-web/src/features/customers/labels.ts`**

```ts
import type { CustomerSource } from './api'

// Days arrive as local calendar days ('2026-10-05'), so they're formatted as UTC to keep the
// day the API meant.
const monthDay = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
})
const monthDayYear = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
})
const monthYear = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric' })

const day = (date: string) => new Date(`${date}T00:00:00Z`)

// 'Next Oct 5' when a visit is coming up, else 'Last visit Sep 12, 2026', else 'No visits yet'.
export function visitLabel(customer: {
  nextVisitDate: string | null
  lastVisitDate: string | null
}): string {
  if (customer.nextVisitDate) return `Next ${monthDay.format(day(customer.nextVisitDate))}`
  if (customer.lastVisitDate) {
    return `Last visit ${monthDayYear.format(day(customer.lastVisitDate))}`
  }
  return 'No visits yet'
}

// '1,240 customers' for the whole list, '3 matches' for a search.
export function countLabel(total: number, searching: boolean): string {
  const count = total.toLocaleString('en-US')
  if (searching) return `${count} ${total === 1 ? 'match' : 'matches'}`
  return `${count} ${total === 1 ? 'customer' : 'customers'}`
}

// 'Showing 26–50 of 1,240'
export function rangeLabel(page: number, pageSize: number, total: number): string {
  const first = (page - 1) * pageSize + 1
  const last = Math.min(page * pageSize, total)
  return `Showing ${first}–${last} of ${total.toLocaleString('en-US')}`
}

// 'Customer since Mar 2025'
export function sinceLabel(createdAt: string): string {
  return `Customer since ${monthYear.format(new Date(createdAt))}`
}

// How the record was first made, after "Customer since …".
export const SOURCE_LABELS: Record<CustomerSource, string> = {
  booking: 'from online booking',
  call: 'from a phone call',
  office: 'added by the office',
  import: 'imported',
}
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `npx vitest run src/features/customers`
Expected: PASS.

- [ ] **Step 7: Typecheck, lint, commit**

```bash
npm run typecheck
npx biome check --write src/features/customers
git add src/features/customers
git commit -m "feat: add the customers api hooks, list URL state and wording"
```

---

### Task 9: Add customer / Edit contact dialog with the duplicate warning

**Files:**
- Create: `relay-web/src/features/customers/contact-dialog.tsx`

**Interfaces:**
- Consumes: `useCreateCustomer`, `useUpdateCustomer`, `usePhoneTwins` (Task 8); `AddressFields`, `addressStarted`, `EMPTY_ADDRESS`, `focusFirstInvalid` (Task 7).
- Produces:
  - `type ContactDialogState = { mode: 'add'; name?: string; phone?: string } | { mode: 'edit'; customer: { id; name; phone: string | null; email: string | null } }`
  - `<ContactDialog state onClose />`, closed while `state` is null

- [ ] **Step 1: Write `relay-web/src/features/customers/contact-dialog.tsx`**

```tsx
import { type FormEvent, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { Link, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { AddressFields } from '@/components/address-fields'
import { Field, type FieldErrors, focusFirstInvalid } from '@/components/form-field'
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
import { addressStarted, EMPTY_ADDRESS } from '@/lib/address'
import { ApiError } from '@/lib/api'
import { errorMessage } from '@/lib/errors'
import { formatPhone } from '@/lib/format'
import { useCreateCustomer, usePhoneTwins, useUpdateCustomer } from './api'

// Adding a customer (maybe with a name or phone from the search box), or editing one's contact.
export type ContactDialogState =
  | { mode: 'add'; name?: string; phone?: string }
  | {
      mode: 'edit'
      customer: { id: string; name: string; phone: string | null; email: string | null }
    }

// Add customer (list) and Edit contact (record). Closed while `state` is null.
export function ContactDialog({
  state,
  onClose,
}: {
  state: ContactDialogState | null
  onClose: () => void
}) {
  const editing = state?.mode === 'edit'
  return (
    <Dialog open={state !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit contact' : 'Add customer'}</DialogTitle>
          <DialogDescription>
            {editing
              ? 'Calls and texts are matched to customers by this phone number.'
              : 'Name and phone are needed. The address can wait.'}
          </DialogDescription>
        </DialogHeader>
        {/* Mounted only while open, so each opening starts from the saved values. */}
        {state !== null && <ContactForm state={state} onDone={onClose} />}
      </DialogContent>
    </Dialog>
  )
}

function ContactForm({ state, onDone }: { state: ContactDialogState; onDone: () => void }) {
  const editing = state.mode === 'edit' ? state.customer : null
  const typed = state.mode === 'add' ? state : null
  const [name, setName] = useState(editing?.name ?? typed?.name ?? '')
  const [phone, setPhone] = useState(
    editing?.phone ? formatPhone(editing.phone) : (typed?.phone ?? ''),
  )
  const [email, setEmail] = useState(editing?.email ?? '')
  const [address, setAddress] = useState(EMPTY_ADDRESS)
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const form = useRef<HTMLFormElement>(null)
  const navigate = useNavigate()
  const create = useCreateCustomer()
  const update = useUpdateCustomer()
  const twin = usePhoneTwins(phone, editing?.id).data?.[0]
  const saving = create.isPending || update.isPending

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    try {
      if (editing) {
        await update.mutateAsync({ id: editing.id, name, phone, email })
        toast.success('Saved')
        onDone()
        return
      }
      const property = addressStarted(address) ? address : undefined
      const { id } = await create.mutateAsync({ name, phone, email, property })
      toast.success(`${name.trim()} added`)
      onDone()
      navigate(`/customers/${id}`)
    } catch (error) {
      if (error instanceof ApiError && error.code === 'validation_failed') {
        flushSync(() => setFieldErrors(error.details))
        focusFirstInvalid(form.current)
      } else {
        setFieldErrors({})
        toast.error(errorMessage(error))
      }
    }
  }

  return (
    <form ref={form} onSubmit={onSubmit} className="space-y-4">
      <Field id="contact-name" label="Name" errors={fieldErrors.name}>
        <Input
          id="contact-name"
          autoComplete="off"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <div className="space-y-1.5">
        <Field id="contact-phone" label="Phone" errors={fieldErrors.phone}>
          <Input
            id="contact-phone"
            type="tel"
            placeholder="(480) 555-0199"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
          />
        </Field>
        {/* Doesn't block saving: a household can share a phone. */}
        {twin && (
          <p className="text-sm text-amber-800">
            {twin.name} already uses this number.{' '}
            <Link
              to={`/customers/${twin.id}`}
              onClick={onDone}
              className="font-medium underline underline-offset-4"
            >
              Open that record
            </Link>
          </p>
        )}
      </div>
      <Field id="contact-email" label="Email (optional)" errors={fieldErrors.email}>
        <Input
          id="contact-email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </Field>
      {!editing && (
        <fieldset className="space-y-3">
          <legend className="mb-2 text-sm font-medium">Service address (optional)</legend>
          <AddressFields
            idPrefix="contact"
            errorPrefix="property"
            value={address}
            errors={fieldErrors}
            onChange={setAddress}
          />
        </fieldset>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving}>
          {saving ? 'Saving…' : editing ? 'Save' : 'Add customer'}
        </Button>
      </DialogFooter>
    </form>
  )
}
```

- [ ] **Step 2: Typecheck, lint, commit**

```bash
npm run typecheck
npx biome check --write src/features/customers/contact-dialog.tsx
git add src/features/customers/contact-dialog.tsx
git commit -m "feat: add the customer contact dialog with a duplicate phone warning"
```

(The dialog is used, and checked by hand, in Task 10.)

---

### Task 10: The customer list screen

**Files:**
- Create: `relay-web/src/routes/customers.tsx`
- Modify: `relay-web/src/router.tsx`
- Modify: `relay-web/src/components/sidebar.tsx:1-25`

**Interfaces:**
- Consumes: `useCustomers`, `ListedCustomer` (Task 8); `readListParams`, `listSearch`, `ListParams`, `Sort` (Task 8); `countLabel`, `rangeLabel`, `visitLabel` (Task 8); `ContactDialog`, `ContactDialogState` (Task 9); `useDebounced` (Task 7).
- Produces:
  - `CustomersPage` at `/customers`
  - each row links to `/customers/:id` with router state `{ listSearch: string }`, which the record page (Task 12) uses for its back link

- [ ] **Step 1: Write `relay-web/src/routes/customers.tsx`**

```tsx
import { ChevronLeft, ChevronRight, Plus, Search, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { StaffPage } from '@/components/staff-layout'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/native-select'
import { type ListedCustomer, useCustomers } from '@/features/customers/api'
import { ContactDialog, type ContactDialogState } from '@/features/customers/contact-dialog'
import { countLabel, rangeLabel, visitLabel } from '@/features/customers/labels'
import {
  type ListParams,
  listSearch,
  readListParams,
  type Sort,
} from '@/features/customers/list-params'
import { errorMessage } from '@/lib/errors'
import { formatPhone } from '@/lib/format'
import { useDebounced } from '@/lib/use-debounced'

// Every customer of the contractor: search, sort, page through and add. Search, sort and page
// live in the URL, so Back from a customer returns to the same spot.
export function CustomersPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const params = readListParams(searchParams)
  const [text, setText] = useState(params.q)
  const [urlQ, setUrlQ] = useState(params.q)
  const typed = useDebounced(text.trim(), 250)
  const customers = useCustomers(params)
  const [adding, setAdding] = useState<ContactDialogState | null>(null)
  const searchBox = useRef<HTMLInputElement>(null)

  function go(next: ListParams, replace = false) {
    setSearchParams(listSearch(next), { replace })
  }

  // The URL's search changed without typing (the sidebar link, Back): show it in the box.
  if (params.q !== urlQ) {
    setUrlQ(params.q)
    if (params.q !== text.trim()) setText(params.q)
  }

  // Typing stopped: search from page 1. Replacing the history entry keeps Back from stepping
  // through every keystroke.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs only when the typed search settles
  useEffect(() => {
    if (typed !== params.q) go({ ...params, q: typed, page: 1 }, true)
  }, [typed])

  // Desktop starts in the search box. Phones don't, so the keyboard doesn't cover the list.
  useEffect(() => {
    if (window.matchMedia('(min-width: 768px)').matches) searchBox.current?.focus()
  }, [])

  function clearSearch() {
    setText('')
    go({ ...params, q: '', page: 1 }, true)
  }

  function changePage(page: number) {
    go({ ...params, page })
    window.scrollTo({ top: 0 })
  }

  // "Add 'xyz' as a customer": digits go in the phone field, anything else in the name.
  function addFromSearch() {
    setAdding(
      /\d{3}/.test(params.q)
        ? { mode: 'add', phone: params.q }
        : { mode: 'add', name: params.q },
    )
  }

  const page = customers.data
  const searching = params.q !== ''
  const lastPage = page ? Math.max(1, Math.ceil(page.total / page.pageSize)) : 1

  return (
    <StaffPage title="Customers">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0 flex-1 basis-64 space-y-1.5">
          <Label htmlFor="customer-search">Search customers</Label>
          <div className="relative">
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              id="customer-search"
              ref={searchBox}
              inputMode="search"
              enterKeyHint="search"
              autoComplete="off"
              placeholder="Name, phone or street"
              className="h-9 pr-10 pl-8"
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
            {text && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={clearSearch}
                className="absolute top-1/2 right-0.5 flex size-8 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <X className="size-4" aria-hidden />
              </button>
            )}
          </div>
        </div>
        <div className="flex items-end gap-2">
          <div className="space-y-1.5">
            <Label htmlFor="customer-sort">Sort</Label>
            <NativeSelect
              id="customer-sort"
              value={params.sort}
              onChange={(event) => go({ ...params, sort: event.target.value as Sort, page: 1 })}
            >
              <option value="name">Name A–Z</option>
              <option value="newest">Recently added</option>
            </NativeSelect>
          </div>
          <Button size="lg" onClick={() => setAdding({ mode: 'add' })}>
            <Plus /> Add customer
          </Button>
        </div>
      </div>

      <p aria-live="polite" className="text-sm text-muted-foreground">
        {page && countLabel(page.total, searching)}
      </p>

      {customers.isPending && <ListSkeleton />}
      {customers.isError && !page && (
        <div className="space-y-2 rounded-lg border border-destructive/30 p-4">
          <p className="text-sm text-destructive">{errorMessage(customers.error)}</p>
          <Button variant="outline" size="sm" onClick={() => customers.refetch()}>
            Try again
          </Button>
        </div>
      )}

      {page?.total === 0 && !searching && (
        <div className="space-y-3 rounded-lg border border-dashed p-6 text-center">
          <p className="font-medium">No customers yet</p>
          <p className="text-sm text-muted-foreground">
            They appear here when someone books online, calls, or the office books a job.
          </p>
          <Button onClick={() => setAdding({ mode: 'add' })}>
            <Plus /> Add customer
          </Button>
        </div>
      )}

      {page?.total === 0 && searching && (
        <div className="space-y-3 rounded-lg border border-dashed p-6 text-center">
          <p className="font-medium">No customers match “{params.q}”</p>
          <p className="text-sm text-muted-foreground">
            Check the spelling, or search by phone number or street.
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            <Button variant="outline" onClick={clearSearch}>
              Clear search
            </Button>
            <Button onClick={addFromSearch}>
              <Plus /> Add “{params.q}” as a customer
            </Button>
          </div>
        </div>
      )}

      {page && page.total > 0 && page.customers.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Nothing on this page.{' '}
          <Button variant="link" className="h-auto p-0" onClick={() => changePage(1)}>
            Go to the first page
          </Button>
        </p>
      )}

      {page && page.customers.length > 0 && (
        <>
          <ul className="divide-y overflow-hidden rounded-xl border bg-card">
            {page.customers.map((customer) => (
              <CustomerRow key={customer.id} customer={customer} backTo={listSearch(params)} />
            ))}
          </ul>
          {page.total > page.pageSize && (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">
                {rangeLabel(params.page, page.pageSize, page.total)}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="lg"
                  disabled={params.page <= 1}
                  onClick={() => changePage(params.page - 1)}
                >
                  <ChevronLeft /> Prev
                </Button>
                <Button
                  variant="outline"
                  size="lg"
                  disabled={params.page >= lastPage}
                  onClick={() => changePage(params.page + 1)}
                >
                  Next <ChevronRight />
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      <ContactDialog state={adding} onClose={() => setAdding(null)} />
    </StaffPage>
  )
}

// One customer, the whole row a link. Phones stack it: name and visit, phone, address.
// From md up it's four columns: name, phone, address, visit.
function CustomerRow({ customer, backTo }: { customer: ListedCustomer; backTo: string }) {
  const [first, ...more] = customer.properties
  return (
    <li>
      <Link
        to={`/customers/${customer.id}`}
        state={{ listSearch: backTo }}
        className="grid gap-0.5 px-4 py-3 text-sm outline-none hover:bg-muted focus-visible:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset md:grid-cols-[minmax(0,1fr)_9rem_minmax(0,1.4fr)_10rem] md:items-center md:gap-4"
      >
        {/* md:contents drops this wrapper on wide screens, so its two parts become grid
            columns; md:order-last sends the visit to the last one. */}
        <span className="flex items-baseline justify-between gap-3 md:contents">
          <span className="truncate text-base font-medium md:text-sm">{customer.name}</span>
          <span className="shrink-0 text-xs text-muted-foreground md:order-last md:text-right md:text-sm">
            {visitLabel(customer)}
          </span>
        </span>
        <span>{customer.phone ? formatPhone(customer.phone) : 'No phone'}</span>
        <span className="truncate text-muted-foreground">
          {first ? `${first.street}, ${first.city}` : 'No address yet'}
          {more.length > 0 && ` +${more.length}`}
        </span>
      </Link>
    </li>
  )
}

function ListSkeleton() {
  return (
    <>
      <p className="sr-only">Loading customers…</p>
      <ul aria-hidden className="divide-y rounded-xl border bg-card">
        {['a', 'b', 'c', 'd', 'e'].map((row) => (
          <li key={row} className="space-y-2 px-4 py-3">
            <div className="h-4 w-1/3 animate-pulse rounded bg-muted" />
            <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
          </li>
        ))}
      </ul>
    </>
  )
}
```

- [ ] **Step 2: Add the route to `relay-web/src/router.tsx`**

Add `import { CustomersPage } from '@/routes/customers'` to the imports (keep them sorted), and add `{ path: '/customers', element: <CustomersPage /> },` right after the `/dashboard` route in the staff children.

- [ ] **Step 3: Add the sidebar link in `relay-web/src/components/sidebar.tsx`**

Add `Contact,` to the `lucide-react` import (keep it sorted, before `LogOut`). Replace the comment and `LINKS` with:

```tsx
// Owner and office screens. More join as their modules arrive (inbox, payments).
const LINKS: { to: string; label: string; icon: LucideIcon }[] = [
  { to: '/dashboard', label: 'Dispatch', icon: CalendarDays },
  { to: '/customers', label: 'Customers', icon: Contact },
  { to: '/technicians', label: 'Technicians', icon: Users },
  { to: '/services', label: 'Services', icon: Wrench },
  { to: '/analytics', label: 'Analytics', icon: ChartColumn },
  { to: '/settings', label: 'Booking settings', icon: Settings },
]
```

- [ ] **Step 4: Typecheck, lint**

```bash
npm run typecheck
npx biome check --write src/routes/customers.tsx src/router.tsx src/components/sidebar.tsx
```

Expected: no errors. If Biome reports the `biome-ignore` comment as unused, the rule didn't fire: delete the comment.

- [ ] **Step 5: Check by hand**

With relay-api and relay-web running, sign in as the office user (seed shop `desert`):
- Sidebar shows Customers under Dispatch. `/customers` lists the seeded customers with "1 customer" / "N customers".
- Type part of a street, then part of a phone number: the list narrows after a pause, the URL gets `?q=…`, and the old rows stay until the new ones arrive.
- Type `zzzz`: "No customers match “zzzz”" with Clear search and Add “zzzz” as a customer. The add button opens the dialog with the name filled in.
- In Add customer, type the phone of an existing customer: "<Name> already uses this number. Open that record" appears.
- Submit with an empty name: the error shows under Name and the cursor is in Name.
- Add a customer with an address. A toast appears, then the browser goes to `/customers/<id>` (a not-found page until Task 12).
- Narrow the window to phone width: rows stack, no sideways scrolling.

- [ ] **Step 6: Commit**

```bash
git add src/routes/customers.tsx src/router.tsx src/components/sidebar.tsx
git commit -m "feat: add the customers list with search, sort and pages"
```

---

### Task 11: Record page parts: notes card, address dialog, job history

**Files:**
- Create: `relay-web/src/features/customers/notes-card.tsx`
- Create: `relay-web/src/features/customers/property-dialog.tsx`
- Create: `relay-web/src/features/customers/job-history.tsx`

**Interfaces:**
- Consumes: `useUpdateCustomer`, `useSaveProperty`, `CustomerProperty`, `CustomerRecord`, `HistoryJob` (Task 8); `AddressFields`, `AddressValue`, `EMPTY_ADDRESS`, `focusFirstInvalid` (Task 7); `installYear`, `ageFrom` (Task 6); `STATUS` from `features/dispatch/labels`.
- Produces:
  - `<NotesCard customerId notes />`
  - `<PropertyDialog customerId property onClose />`, where `property` is a `CustomerProperty`, `'new'`, or `null` (closed)
  - `<JobHistory record onOpen />`, where `onOpen(jobId)` opens the drawer

- [ ] **Step 1: Write `relay-web/src/features/customers/notes-card.tsx`**

```tsx
import { cn } from 'cn'
import { Pencil } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { FieldMessages } from '@/components/form-field'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { ApiError } from '@/lib/api'
import { errorMessage } from '@/lib/errors'
import { useUpdateCustomer } from './api'

// The same limit as relay-api; the counter shows near it.
const NOTES_LIMIT = 2000

// The customer's notes, edited right in the card. Escape cancels, Ctrl+Enter saves.
export function NotesCard({ customerId, notes }: { customerId: string; notes: string | null }) {
  const [draft, setDraft] = useState<string | null>(null) // null = not editing
  const [errors, setErrors] = useState<string[] | undefined>()
  const update = useUpdateCustomer()

  function cancel() {
    setDraft(null)
    setErrors(undefined)
  }

  function save() {
    if (draft === null) return
    update.mutate(
      { id: customerId, notes: draft },
      {
        onSuccess: () => {
          cancel()
          toast.success('Saved')
        },
        onError: (error) => {
          if (error instanceof ApiError && error.details.notes) setErrors(error.details.notes)
          else toast.error(errorMessage(error))
        },
      },
    )
  }

  return (
    <section className="space-y-2 rounded-xl border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold">Notes</h2>
        {draft === null && (
          <Button variant="ghost" size="sm" onClick={() => setDraft(notes ?? '')}>
            <Pencil /> Edit
          </Button>
        )}
      </div>
      {draft === null ? (
        notes ? (
          <p className="text-sm whitespace-pre-wrap">{notes}</p>
        ) : (
          <p className="text-sm text-muted-foreground">
            No notes. Add things like ‘prefers mornings’ or ‘pays by check’.
          </p>
        )
      ) : (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault()
            save()
          }}
        >
          <Textarea
            aria-label="Notes"
            aria-invalid={errors ? true : undefined}
            aria-describedby={errors ? 'customer-notes-error' : undefined}
            autoFocus
            rows={4}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                cancel()
              }
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault()
                save()
              }
            }}
          />
          {errors && <FieldMessages id="customer-notes-error" messages={errors} />}
          {draft.length > NOTES_LIMIT - 200 && (
            <p
              className={cn(
                'text-xs',
                draft.length > NOTES_LIMIT ? 'text-destructive' : 'text-muted-foreground',
              )}
            >
              {draft.length.toLocaleString('en-US')} / {NOTES_LIMIT.toLocaleString('en-US')}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={cancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={update.isPending}>
              {update.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </form>
      )}
    </section>
  )
}
```

- [ ] **Step 2: Write `relay-web/src/features/customers/property-dialog.tsx`**

```tsx
import { type FormEvent, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { toast } from 'sonner'
import { AddressFields } from '@/components/address-fields'
import { Field, type FieldErrors, focusFirstInvalid } from '@/components/form-field'
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
import { Textarea } from '@/components/ui/textarea'
import { type AddressValue, EMPTY_ADDRESS } from '@/lib/address'
import { ApiError } from '@/lib/api'
import { ageFrom, installYear } from '@/lib/equipment'
import { errorMessage } from '@/lib/errors'
import { type CustomerProperty, useSaveProperty } from './api'

// Suggestions only: any brand can be typed. Keeps the common ones spelled one way.
const BRANDS = [
  'Amana',
  'American Standard',
  'Bryant',
  'Carrier',
  'Daikin',
  'Goodman',
  'Lennox',
  'Mitsubishi',
  'Rheem',
  'Ruud',
  'Trane',
  'York',
]

// Add an address (`property` = 'new') or edit one, with its equipment and access notes.
// Closed while `property` is null.
export function PropertyDialog({
  customerId,
  property,
  onClose,
}: {
  customerId: string
  property: CustomerProperty | 'new' | null
  onClose: () => void
}) {
  const editing = property !== null && property !== 'new' ? property : null
  return (
    <Dialog open={property !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit address' : 'Add address'}</DialogTitle>
          <DialogDescription>Where the work happens, and what’s installed there.</DialogDescription>
        </DialogHeader>
        {property !== null && (
          <PropertyForm
            key={editing?.id ?? 'new'}
            customerId={customerId}
            editing={editing}
            onDone={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function PropertyForm({
  customerId,
  editing,
  onDone,
}: {
  customerId: string
  editing: CustomerProperty | null
  onDone: () => void
}) {
  const [address, setAddress] = useState<AddressValue>(
    editing
      ? {
          street: editing.street,
          unit: editing.unit ?? '',
          city: editing.city,
          state: editing.state,
          zip: editing.zip,
        }
      : EMPTY_ADDRESS,
  )
  const [brand, setBrand] = useState(editing?.equipmentBrand ?? '')
  const [age, setAge] = useState(
    editing?.equipmentYear != null ? String(ageFrom(editing.equipmentYear)) : '',
  )
  const [notes, setNotes] = useState(editing?.notes ?? '')
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const form = useRef<HTMLFormElement>(null)
  const save = useSaveProperty(customerId)
  // A whole number of years, or null while the box is empty or not a number.
  const years = /^\d+$/.test(age.trim()) ? Number(age.trim()) : null

  function showErrors(details: FieldErrors) {
    flushSync(() => setFieldErrors(details))
    focusFirstInvalid(form.current)
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (age.trim() !== '' && years === null) {
      showErrors({ equipmentYear: ['Enter the age in whole years, like 12'] })
      return
    }
    try {
      await save.mutateAsync({
        id: editing?.id,
        ...address,
        equipmentBrand: brand,
        equipmentYear: years === null ? null : installYear(years),
        notes,
      })
      toast.success('Saved')
      onDone()
    } catch (error) {
      if (error instanceof ApiError && error.code === 'validation_failed') {
        showErrors(error.details)
      } else {
        setFieldErrors({})
        toast.error(errorMessage(error))
      }
    }
  }

  return (
    <form ref={form} onSubmit={onSubmit} className="space-y-4">
      <AddressFields
        idPrefix="property"
        errorPrefix=""
        value={address}
        errors={fieldErrors}
        onChange={setAddress}
      />
      {editing && (
        <p className="text-sm text-muted-foreground">
          Customer moved? Add a new address instead, so past jobs keep the old one.
        </p>
      )}
      <fieldset className="space-y-3">
        <legend className="mb-2 text-sm font-medium">Equipment</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="property-brand" label="Brand" errors={fieldErrors.equipmentBrand}>
            <Input
              id="property-brand"
              list="equipment-brands"
              autoComplete="off"
              value={brand}
              onChange={(event) => setBrand(event.target.value)}
            />
          </Field>
          <Field id="property-age" label="Age in years" errors={fieldErrors.equipmentYear}>
            <Input
              id="property-age"
              inputMode="numeric"
              placeholder="About how old?"
              value={age}
              onChange={(event) => setAge(event.target.value)}
            />
          </Field>
        </div>
        <datalist id="equipment-brands">
          {BRANDS.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
        {years !== null && (
          <p className="text-sm text-muted-foreground">≈ installed {installYear(years)}</p>
        )}
      </fieldset>
      <Field id="property-notes" label="Access notes" errors={fieldErrors.notes}>
        <Textarea
          id="property-notes"
          rows={2}
          placeholder="Gate code, pets, attic access"
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
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

- [ ] **Step 3: Write `relay-web/src/features/customers/job-history.tsx`**

```tsx
import { cn } from 'cn'
import { Badge } from '@/components/ui/badge'
import { STATUS } from '@/features/dispatch/labels'
import type { CustomerRecord, HistoryJob } from './api'

// The customer's jobs: Upcoming (soonest first), then Past (newest first). A row opens the
// job drawer.
export function JobHistory({
  record,
  onOpen,
}: {
  record: CustomerRecord
  onOpen: (jobId: string) => void
}) {
  const { jobs, jobsTotal, properties } = record
  // The street only helps when there's more than one address to tell apart.
  const streetOf = (propertyId: string) =>
    properties.length > 1 ? properties.find((p) => p.id === propertyId)?.street : undefined

  return (
    <section className="space-y-4 rounded-xl border bg-card p-4">
      <h2 className="font-semibold">Jobs ({jobsTotal.toLocaleString('en-US')})</h2>
      {jobs.length === 0 && <p className="text-sm text-muted-foreground">No jobs yet.</p>}
      <JobGroup
        title="Upcoming"
        jobs={jobs.filter((job) => job.upcoming)}
        streetOf={streetOf}
        onOpen={onOpen}
      />
      <JobGroup
        title="Past"
        jobs={jobs.filter((job) => !job.upcoming)}
        streetOf={streetOf}
        onOpen={onOpen}
      />
      {jobsTotal > jobs.length && (
        <p className="text-xs text-muted-foreground">Showing the latest {jobs.length} jobs.</p>
      )}
    </section>
  )
}

function JobGroup({
  title,
  jobs,
  streetOf,
  onOpen,
}: {
  title: string
  jobs: HistoryJob[]
  streetOf: (propertyId: string) => string | undefined
  onOpen: (jobId: string) => void
}) {
  if (jobs.length === 0) return null
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {title}
      </h3>
      <ul className="divide-y overflow-hidden rounded-lg border">
        {jobs.map((job) => (
          <li key={job.id}>
            <button
              type="button"
              onClick={() => onOpen(job.id)}
              className={cn(
                'flex w-full items-start justify-between gap-3 px-3 py-2.5 text-left text-sm outline-none hover:bg-muted focus-visible:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset',
                job.status === 'cancelled' && 'opacity-60',
              )}
            >
              <span className="min-w-0 space-y-0.5">
                <span className="block font-medium">
                  {job.dateLabel} · {job.windowLabel}
                </span>
                <span className="block truncate">
                  {job.serviceName} · {job.problem}
                </span>
                <span className="block text-muted-foreground">
                  {[job.technicianName ?? 'Unassigned', streetOf(job.propertyId)]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
              <Badge className={STATUS[job.status].chip}>{STATUS[job.status].label}</Badge>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
```

- [ ] **Step 4: Typecheck, lint, commit**

```bash
npm run typecheck
npx biome check --write src/features/customers
git add src/features/customers
git commit -m "feat: add the customer notes card, address dialog and job history"
```

(They're put on screen and checked by hand in Task 12.)

---

### Task 12: The customer record page

**Files:**
- Create: `relay-web/src/routes/customer.tsx`
- Modify: `relay-web/src/router.tsx`

**Interfaces:**
- Consumes: `useCustomer`, `customerKey`, `CustomerRecord`, `CustomerProperty` (Task 8); `SOURCE_LABELS`, `sinceLabel` (Task 8); `ContactDialog` (Task 9); `NotesCard`, `PropertyDialog`, `JobHistory` (Task 11); `JobDrawer`, `BookJobDialog` with `customer` (Task 7), `todayIn` from dispatch; `equipmentLabel` (Task 6); `buttonVariants`.
- Produces: `CustomerPage` at `/customers/:customerId`.

- [ ] **Step 1: Write `relay-web/src/routes/customer.tsx`**

```tsx
import { useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, MessageSquare, Pencil, Phone, Plus } from 'lucide-react'
import { useState } from 'react'
import { Link, useLocation, useParams } from 'react-router'
import { Button, buttonVariants } from '@/components/ui/button'
import {
  type CustomerProperty,
  type CustomerRecord,
  customerKey,
  useCustomer,
} from '@/features/customers/api'
import { ContactDialog, type ContactDialogState } from '@/features/customers/contact-dialog'
import { JobHistory } from '@/features/customers/job-history'
import { SOURCE_LABELS, sinceLabel } from '@/features/customers/labels'
import { NotesCard } from '@/features/customers/notes-card'
import { PropertyDialog } from '@/features/customers/property-dialog'
import { BookJobDialog } from '@/features/dispatch/book-job-dialog'
import { todayIn } from '@/features/dispatch/dates'
import { JobDrawer } from '@/features/dispatch/job-drawer'
import { ApiError } from '@/lib/api'
import { equipmentLabel } from '@/lib/equipment'
import { errorMessage } from '@/lib/errors'
import { formatPhone } from '@/lib/format'

// One customer: contact, notes, addresses with equipment, and every job. The office books
// the next visit from here.
export function CustomerPage() {
  const { customerId = '' } = useParams()
  const location = useLocation()
  const record = useCustomer(customerId)
  // Coming from the list, "Customers" returns to the same search and page.
  const listSearch = (location.state as { listSearch?: string } | null)?.listSearch
  const back = listSearch ? `/customers?${listSearch}` : '/customers'
  const notFound = record.error instanceof ApiError && record.error.status === 404

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-4 sm:p-6">
      <Link
        to={back}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:underline"
      >
        <ChevronLeft className="size-4" aria-hidden /> Customers
      </Link>

      {record.isPending && <RecordSkeleton />}
      {notFound && (
        <div className="space-y-2 rounded-lg border border-dashed p-6 text-center">
          <h1 className="text-lg font-semibold">Customer not found</h1>
          <p className="text-sm text-muted-foreground">The link may be wrong or out of date.</p>
          <Link to="/customers" className={buttonVariants({ variant: 'outline' })}>
            Back to customers
          </Link>
        </div>
      )}
      {record.isError && !notFound && (
        <div className="space-y-2 rounded-lg border border-destructive/30 p-4">
          <p className="text-sm text-destructive">{errorMessage(record.error)}</p>
          <Button variant="outline" size="sm" onClick={() => record.refetch()}>
            Try again
          </Button>
        </div>
      )}
      {record.data && <Record record={record.data} />}
    </main>
  )
}

function Record({ record }: { record: CustomerRecord }) {
  const { customer, properties } = record
  const queryClient = useQueryClient()
  const [contact, setContact] = useState<ContactDialogState | null>(null)
  const [property, setProperty] = useState<CustomerProperty | 'new' | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const [booking, setBooking] = useState(false)
  const refresh = () => queryClient.invalidateQueries({ queryKey: customerKey(customer.id) })

  return (
    <>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{customer.name}</h1>
          <p className="text-sm">
            {[customer.phone && formatPhone(customer.phone), customer.email]
              .filter(Boolean)
              .join(' · ') || 'No phone or email'}
          </p>
          <p className="text-sm text-muted-foreground">
            {sinceLabel(customer.createdAt)} · {SOURCE_LABELS[customer.source]}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {customer.phone && (
            <>
              <a
                href={`tel:${customer.phone}`}
                className={buttonVariants({ variant: 'outline', size: 'lg' })}
              >
                <Phone aria-hidden /> Call
              </a>
              <a
                href={`sms:${customer.phone}`}
                className={buttonVariants({ variant: 'outline', size: 'lg' })}
              >
                <MessageSquare aria-hidden /> Text
              </a>
            </>
          )}
          <Button variant="outline" size="lg" onClick={() => setContact({ mode: 'edit', customer })}>
            <Pencil /> Edit contact
          </Button>
          <Button size="lg" onClick={() => setBooking(true)}>
            <Plus /> Book job
          </Button>
        </div>
      </header>

      {/* Phones read top to bottom: notes, addresses, then jobs. Desktop puts jobs on the
          left and notes with addresses on the right. */}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
        <div className="space-y-6 lg:col-start-2 lg:row-start-1">
          <NotesCard customerId={customer.id} notes={customer.notes} />
          <Addresses properties={properties} onEdit={setProperty} />
        </div>
        <div className="lg:col-start-1 lg:row-start-1">
          <JobHistory record={record} onOpen={setJobId} />
        </div>
      </div>

      <ContactDialog state={contact} onClose={() => setContact(null)} />
      <PropertyDialog
        customerId={customer.id}
        property={property}
        onClose={() => setProperty(null)}
      />
      <JobDrawer
        jobId={jobId}
        onClose={() => {
          setJobId(null)
          refresh()
        }}
      />
      <BookJobDialog
        open={booking}
        defaultDate={todayIn()}
        customer={{ ...customer, properties }}
        onClose={() => setBooking(false)}
        onBooked={() => {
          setBooking(false)
          refresh()
        }}
      />
    </>
  )
}

function Addresses({
  properties,
  onEdit,
}: {
  properties: CustomerProperty[]
  onEdit: (property: CustomerProperty | 'new') => void
}) {
  return (
    <section className="space-y-3 rounded-xl border bg-card p-4">
      <h2 className="font-semibold">{properties.length === 1 ? 'Address' : 'Addresses'}</h2>
      {properties.length === 0 && (
        <p className="text-sm text-muted-foreground">No address yet. Add one to book a visit.</p>
      )}
      {properties.length > 0 && (
        <ul className="space-y-3">
          {properties.map((property) => (
            <li key={property.id} className="space-y-1 rounded-lg border p-3 text-sm">
              <div className="flex items-start justify-between gap-2">
                <p>
                  {property.street}
                  {property.unit && `, ${property.unit}`}
                  <br />
                  {property.city}, {property.state} {property.zip}
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Edit ${property.street}`}
                  onClick={() => onEdit(property)}
                >
                  <Pencil /> Edit
                </Button>
              </div>
              <p className="text-muted-foreground">
                Equipment:{' '}
                {equipmentLabel(property.equipmentBrand, property.equipmentYear) ?? 'Not recorded'}
              </p>
              {property.notes && (
                <p className="whitespace-pre-wrap text-muted-foreground">
                  Access: {property.notes}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      <Button variant="outline" onClick={() => onEdit('new')}>
        <Plus /> Add address
      </Button>
    </section>
  )
}

function RecordSkeleton() {
  return (
    <div aria-hidden className="space-y-6">
      <p className="sr-only">Loading customer…</p>
      <div className="space-y-2">
        <div className="h-7 w-1/3 animate-pulse rounded bg-muted" />
        <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="h-64 animate-pulse rounded-xl bg-muted" />
        <div className="h-40 animate-pulse rounded-xl bg-muted" />
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Add the route to `relay-web/src/router.tsx`**

Add `import { CustomerPage } from '@/routes/customer'` (sorted) and, right after the `/customers` route, `{ path: '/customers/:customerId', element: <CustomerPage /> },`.

- [ ] **Step 3: Typecheck, lint**

```bash
npm run typecheck
npx biome check --write src/routes/customer.tsx src/router.tsx
```

Expected: no errors.

- [ ] **Step 4: Check by hand**

With both apps running, as the office user:
- Search the list, open a customer, then click "‹ Customers": the same search and page come back.
- Header: name, phone · email, "Customer since … · …", Call, Text, Edit contact, Book job.
- Notes: Edit, type, Ctrl+Enter saves (toast "Saved"). Edit, Escape cancels. Blank and save shows the empty hint.
- Add address with brand "Carrier" and age 12: the hint reads "≈ installed 2014". After saving, the block shows "Equipment: Carrier · about 12 years old". Type age "abc": the error appears under Age.
- Edit that address: the moved hint shows. Open a job at that address on the dispatch board: the drawer shows the same equipment wording.
- Book job: the dialog opens with the customer picked and the first address selected. After booking, the job appears under Upcoming.
- Click a job in the history: the job drawer opens. Change its status, close it, and the history shows the new status.
- `/customers/00000000-0000-0000-0000-000000000000` shows "Customer not found".
- Phone width: notes, addresses, then jobs, with no sideways scrolling.

- [ ] **Step 5: Commit**

```bash
git add src/routes/customer.tsx src/router.tsx
git commit -m "feat: add the customer record page with booking from it"
```

---

### Task 13: Final verification in both repos

**Files:** none new.

- [ ] **Step 1: relay-api full check**

```bash
cd relay-api
npm run typecheck
npx vitest run
npx biome check src/modules/customers src/modules/booking/booking.schemas.ts src/lib/labels.ts src/lib/labels.test.ts
```

Expected: no type errors, all tests pass, Biome clean.

- [ ] **Step 2: relay-web full check**

```bash
cd relay-web
npm run typecheck
npx vitest run
npm run build
npx biome check src/features/customers src/routes/customers.tsx src/routes/customer.tsx src/router.tsx src/components src/lib src/features/dispatch/book-job-dialog.tsx src/features/dispatch/job-drawer.tsx src/features/technician-jobs/job-details.tsx
```

Expected: no type errors, all tests pass, the build succeeds, Biome clean.

- [ ] **Step 3: Headless Edge walk-through**

Follow the project's headless Edge method (CDP-driven Edge `--inprivate`) and screenshot at 1280px and 390px wide:
- `/customers` (list, search with matches, no matches, Add customer with the duplicate warning)
- `/customers/<Maria's id>` (record with notes, an address with equipment, Upcoming and Past jobs, the job drawer open)
- the technician job page for one of that customer's jobs (equipment wording)

Check against the spec's "What the office sees" section. Fix anything that differs, then re-run Steps 1–2.

- [ ] **Step 4: Report**

Summarise what was built and what was checked, with test counts from Steps 1–2 and the screenshots from Step 3. Note anything that was skipped. Don't merge or push; that's the user's call (superpowers:finishing-a-development-branch).
