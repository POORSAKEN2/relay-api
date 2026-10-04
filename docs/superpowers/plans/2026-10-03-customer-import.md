# Customer Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The owner or office imports customers from a `.csv` or `.xlsx` file in four steps (file, columns, check, done): every row is checked before anything is saved, customers already in Relay are skipped, and a whole import can be undone.

**Architecture:** relay-web reads the file in the browser (`papaparse`, `read-excel-file`, both loaded only on the import page), guesses which column fills which field, and sends plain text rows. relay-api reads and validates every row with the existing contact and address rules (`customers.schemas.ts`), sorts rows into ready / already in Relay / repeated / needs fixing, saves ready rows in one transaction as a batch (`customer_imports`), and can undo a batch. One helper, `customerMatchKey`, is the only definition of "same customer", shared with online booking.

**Tech Stack:** relay-api: Express 5, Drizzle ORM 0.45 + drizzle-kit, PostgreSQL 18, Zod 4, Vitest + Supertest. relay-web: React 19, React Router 8, TanStack Query 5, Zod 4, Base UI (shadcn), sonner, lucide, Vitest (node environment), papaparse 5, read-excel-file 9.

**Spec:** `relay-api/docs/superpowers/specs/2026-10-03-customer-import-design.md`

## Global Constraints

- Two git repos: `relay-api` and `relay-web`. Branch `feat/customer-import` in both, created from `feat/customers-screen` (part 1, not merged yet). The controller creates the branches before Task 1.
- Architecture: a rule lives in exactly one place. Modules keep routes → service → queries. The import code lives in the `customers` module/feature. Pure functions get their own tests. Code stays plain enough for a junior developer to debug: no speculative abstractions.
- Commit messages: lowercase conventional (`feat: …`, `refactor: …`, `test: …`, `docs: …`). **No `Co-Authored-By` trailer.**
- Biome only on touched files: `npx biome check --write <paths>`.
- Edit files only with the Write/Edit tools, never through PowerShell or shell rewrites (they add a UTF-8 BOM and mojibake). In relay-web JSX text, write typographic quotes and apostrophes as HTML entities (`&rsquo;` `&lsquo;` `&ldquo;` `&rdquo;`); plain TypeScript strings may use `’` directly.
- relay-api tests need the local test database (`relay_test`) running; `test/global-setup.ts` applies migrations to it.
- Limits: 5,000 rows per import, 5 MB per file and per JSON body for the import POSTs, 2,000 characters per cell.
- No `consent_events` rows and no texts for imported customers.
- Exact copy (API):
  - `Nothing to import: no row is ready.` (422, code `nothing_to_import`)
  - `That import wasn’t found.` (404, code `not_found`)
  - `This import was already undone.` (409, code `already_undone`)
  - `Import up to 5,000 rows at a time` / `The file has no rows to import` / `That import link isn’t valid`
  - `Couldn’t split the address. Write it as street, city, ST ZIP`
  - `Couldn’t read the equipment age or install year`
  - `Equipment and access notes need an address`
  - every other row problem is the existing field message from `customers.schemas.ts` / `lib/fields.ts`
- Exact copy (web): as written in each task's code (help text, errors, summaries, confirm dialog).

## File map

relay-api:
- Create `src/modules/customers/customer-match.ts` (+ test): `customerMatchKey`.
- Modify `src/modules/customers/customers.queries.ts`: `findCustomerByPhoneAndName` uses `customerMatchKey`.
- Modify `src/modules/customers/customers.schemas.ts`: export `CustomerNotes`.
- Modify `src/db/schema.ts` + new `drizzle/0009_customer_imports.sql` (+ meta): `customer_imports`, `customers.import_id`.
- Create `src/modules/customers/imports.schemas.ts`, `import-rows.ts` (+ `import-rows.test.ts`), `imports.queries.ts`, `imports.service.ts`, `imports.routes.ts`, `imports.test.ts`.
- Modify `src/app.ts`: 5 MB parser for `/api/customers/imports`, mount `importsRoutes` before `customersRoutes`.

relay-web:
- `package.json`: `papaparse`, `read-excel-file`, dev `@types/papaparse`.
- Create `src/features/customers/import/`: `fields.ts`, `guess-columns.ts` (+test), `to-rows.ts` (+test), `problem-rows.ts` (+test), `read-file.ts` (+test), `labels.ts` (+test), `api.ts`, `step-bar.tsx`, `file-step.tsx`, `past-imports.tsx`, `columns-step.tsx`, `check-step.tsx`, `done-step.tsx`.
- Create `src/routes/customers-import.tsx`; modify `src/router.tsx`, `src/routes/customers.tsx` (Import buttons).

---

### Task 1: One definition of "same customer"

**Files:**
- Create: `relay-api/src/modules/customers/customer-match.ts`, `relay-api/src/modules/customers/customer-match.test.ts`
- Modify: `relay-api/src/modules/customers/customers.queries.ts` (`findCustomerByPhoneAndName`)

**Interfaces:**
- Produces: `customerMatchKey(phone: string, name: string): string`. Two customers are the same when their keys are equal.

- [ ] **Step 1: Commit the spec and plan on the branch**

The branch `feat/customer-import` already exists and is checked out (confirm with `git branch --show-current`).

```bash
cd relay-api
git add docs/superpowers/specs/2026-10-03-customer-import-design.md docs/superpowers/plans/2026-10-03-customer-import.md
git commit -m "docs: add the customer import spec and plan"
```

- [ ] **Step 2: Write the failing test**

`relay-api/src/modules/customers/customer-match.test.ts`:

```ts
import { expect, it } from 'vitest'
import { customerMatchKey } from './customer-match.ts'

it('ignores case and extra spaces in the name', () => {
  expect(customerMatchKey('+16025550111', '  maria   LOPEZ ')).toBe('+16025550111|maria lopez')
  expect(customerMatchKey('+16025550111', 'Maria Lopez')).toBe(
    customerMatchKey('+16025550111', 'maria lopez'),
  )
})

it('tells apart a different phone or a different name', () => {
  const maria = customerMatchKey('+16025550111', 'Maria Lopez')
  expect(customerMatchKey('+16025550112', 'Maria Lopez')).not.toBe(maria)
  expect(customerMatchKey('+16025550111', 'Mario Lopez')).not.toBe(maria)
})
```

- [ ] **Step 3: Run it to see it fail**

Run: `npx vitest run src/modules/customers/customer-match.test.ts`
Expected: FAIL, "Failed to load url ./customer-match.ts" (or similar: the module doesn't exist).

- [ ] **Step 4: Write `relay-api/src/modules/customers/customer-match.ts`**

```ts
// Two customer records are the same person when they have the same phone and the same name.
// A household can share a phone, so the name tells its people apart. Case and extra spaces in
// the name don't count: 'maria  LOPEZ' is 'Maria Lopez'. The only definition: online booking
// and spreadsheet import both use it. `phone` is E.164 ('+16025550111').
export function customerMatchKey(phone: string, name: string): string {
  return `${phone}|${name.trim().replace(/\s+/g, ' ').toLowerCase()}`
}
```

- [ ] **Step 5: Run it to see it pass**

Run: `npx vitest run src/modules/customers/customer-match.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Make `findCustomerByPhoneAndName` use it**

In `relay-api/src/modules/customers/customers.queries.ts`, add `import { customerMatchKey } from './customer-match.ts'` to the imports and replace the whole `findCustomerByPhoneAndName` function (and its comment) with:

```ts
// The customer with this phone number and name (customerMatchKey); the oldest one when
// several match.
export async function findCustomerByPhoneAndName(
  tenantId: string,
  phone: string,
  name: string,
  tx: Db = db,
) {
  const samePhone = await tx
    .select()
    .from(customers)
    .where(and(eq(customers.tenantId, tenantId), eq(customers.phone, phone)))
    .orderBy(asc(customers.createdAt))
  const key = customerMatchKey(phone, name)
  return samePhone.find((customer) => customerMatchKey(phone, customer.name) === key)
}
```

Keep every other function as it is (`sql` is still used by other queries in the file).

- [ ] **Step 7: Run the tests that use it**

Run: `npx vitest run src/modules/customers src/modules/online-booking`
Expected: PASS (online booking's returning-customer tests unchanged).

- [ ] **Step 8: Typecheck, lint, commit**

```bash
npm run typecheck
npx biome check --write src/modules/customers/customer-match.ts src/modules/customers/customer-match.test.ts src/modules/customers/customers.queries.ts
git add src/modules/customers/customer-match.ts src/modules/customers/customer-match.test.ts src/modules/customers/customers.queries.ts
git commit -m "refactor: define a returning customer in one place"
```

---

### Task 2: Import batches in the database

**Files:**
- Modify: `relay-api/src/db/schema.ts` (section 7 · Customers)
- Create (generated): `relay-api/drizzle/0009_customer_imports.sql`, `relay-api/drizzle/meta/0009_snapshot.json`, `relay-api/drizzle/meta/_journal.json` entry

**Interfaces:**
- Produces: table `customerImports` (`id`, `tenantId`, `createdBy`, `fileName`, `createdCount`, `skippedCount`, `keptCount` nullable, `createdAt`, `undoneAt` nullable); column `customers.importId` (nullable).

- [ ] **Step 1: Add the table before `customers`**

In `relay-api/src/db/schema.ts`, directly after the line `export const CUSTOMER_SOURCES = ['booking', 'call', 'office', 'import'] as const`, add:

```ts
// One row per spreadsheet the office imported, so imports can be listed and undone.
export const customerImports = pgTable(
  'customer_imports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    createdBy: uuid('created_by').notNull(),
    fileName: text('file_name').notNull(),
    createdCount: integer('created_count').notNull(),
    skippedCount: integer('skipped_count').notNull(), // already in Relay, repeated or invalid
    keptCount: integer('kept_count'), // set by undo: customers kept because they have history
    createdAt: createdAt(),
    undoneAt: timestamptz('undone_at'),
  },
  (t) => [
    unique().on(t.tenantId, t.id),
    foreignKey({
      name: 'customer_imports_created_by_fk',
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    check(
      'customer_imports_counts_not_negative',
      sql`${t.createdCount} >= 0 and ${t.skippedCount} >= 0 and (${t.keptCount} is null or ${t.keptCount} >= 0)`,
    ),
    check('customer_imports_undo_complete', sql`(${t.undoneAt} is null) = (${t.keptCount} is null)`),
    index('customer_imports_tenant_created_idx').on(t.tenantId, t.createdAt.desc()),
  ],
)
```

- [ ] **Step 2: Add `import_id` to `customers`**

In the same file's `customers` table: add the column after `source`:

```ts
    importId: uuid('import_id'), // the spreadsheet import that added it; null otherwise
```

and add to its constraint list (after `check('customers_source_valid', …)`):

```ts
    foreignKey({
      name: 'customers_import_fk',
      columns: [t.tenantId, t.importId],
      foreignColumns: [customerImports.tenantId, customerImports.id],
    }),
    check('customers_import_has_source', sql`${t.importId} is null or ${t.source} = 'import'`),
    index('customers_tenant_import_idx').on(t.tenantId, t.importId),
```

- [ ] **Step 3: Generate the migration**

Run: `npx drizzle-kit generate --name customer_imports`
Expected: a new `drizzle/0009_customer_imports.sql` plus `drizzle/meta/0009_snapshot.json` and a journal entry. Open the SQL and check it contains only: `CREATE TABLE "customer_imports"` with the columns above, `ALTER TABLE "customers" ADD COLUMN "import_id" uuid`, the two foreign keys, the two `customer_imports` checks plus `customers_import_has_source`, the `customer_imports` tenant FK, and the two indexes. Nothing else may change.

- [ ] **Step 4: Apply it and run the whole suite**

```bash
npm run db:migrate
npm run typecheck
npx vitest run
```

Expected: "Migrations applied"; typecheck clean; every test passes (the test database gets the migration in `test/global-setup.ts`).

- [ ] **Step 5: Lint, commit**

```bash
npx biome check --write src/db/schema.ts
git add src/db/schema.ts drizzle/0009_customer_imports.sql drizzle/meta/0009_snapshot.json drizzle/meta/_journal.json
git commit -m "feat: record customer imports so they can be undone"
```

Paste the generated SQL into the report (the user reviews schema changes as SQL).

---

### Task 3: Reading a spreadsheet row

**Files:**
- Create: `relay-api/src/modules/customers/imports.schemas.ts`, `relay-api/src/modules/customers/import-rows.ts`, `relay-api/src/modules/customers/import-rows.test.ts`
- Modify: `relay-api/src/modules/customers/customers.schemas.ts` (export `CustomerNotes`)

**Interfaces:**
- Consumes: `NewCustomer`, `PropertyInput` from `customers.schemas.ts`.
- Produces:
  - `ImportRow` (zod) and `type ImportRow = { row: number; name?; lastName?; phone?; email?; street?; unit?; city?; state?; zip?; address?; equipmentBrand?; equipmentAge?; accessNotes?; notes? }` (all optional fields are strings)
  - `CustomerNotes` (zod) in `customers.schemas.ts`
  - `readImportRow(row: ImportRow, addressInOneColumn: boolean, today?: Date): RowReading`
  - `type ReadyRow = { customer: ImportedCustomer; property: ImportedProperty | null }`
  - `type RowReading = { ok: true; value: ReadyRow } | { ok: false; problems: string[] }`
  - `splitAddress`, `stateCode`, `cleanZip`, and the constants `ADDRESS_NOT_SPLIT`, `AGE_UNREADABLE`, `EXTRAS_NEED_ADDRESS`

- [ ] **Step 1: Write the failing tests**

`relay-api/src/modules/customers/import-rows.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  ADDRESS_NOT_SPLIT,
  AGE_UNREADABLE,
  cleanZip,
  EXTRAS_NEED_ADDRESS,
  readImportRow,
  splitAddress,
  stateCode,
} from './import-rows.ts'

const today = new Date(2026, 9, 3)
const maria = { name: 'Maria', lastName: 'Lopez', phone: '(602) 555-0111' }
const palmSt = { street: '12 Palm St', city: 'Phoenix', state: 'AZ', zip: '85004' }
const read = (row: object, addressInOneColumn = false) =>
  readImportRow({ row: 2, ...row }, addressInOneColumn, today)

describe('readImportRow', () => {
  it('reads a contact-only row', () => {
    expect(
      read({ name: '  Maria ', lastName: ' Lopez', phone: '602.555.0111', email: ' Maria@Example.com ' }),
    ).toEqual({
      ok: true,
      value: {
        customer: { name: 'Maria Lopez', phone: '+16025550111', email: 'maria@example.com', notes: null },
        property: null,
      },
    })
  })

  it('reads phones however they were typed or stored', () => {
    for (const phone of ['6025550111', '1-602-555-0111', '+1 (602) 555 0111', '16025550111']) {
      expect(read({ name: 'Maria', phone })).toMatchObject({
        ok: true,
        value: { customer: { phone: '+16025550111' } },
      })
    }
  })

  it('reads an address in separate columns, with a state name and a ZIP+4', () => {
    expect(
      read({
        ...maria,
        street: '12 Palm St',
        unit: '4',
        city: 'Phoenix',
        state: 'Arizona',
        zip: '85004-1234',
        equipmentBrand: 'Carrier',
        equipmentAge: '12',
        accessNotes: 'Gate 4411',
        notes: 'Pays by check',
      }),
    ).toEqual({
      ok: true,
      value: {
        customer: { name: 'Maria Lopez', phone: '+16025550111', notes: 'Pays by check' },
        property: {
          street: '12 Palm St',
          unit: '4',
          city: 'Phoenix',
          state: 'AZ',
          zip: '85004',
          equipmentBrand: 'Carrier',
          equipmentYear: 2014,
          notes: 'Gate 4411',
        },
      },
    })
  })

  it('reads an address in one column', () => {
    expect(read({ ...maria, address: '12 Palm St, Unit 4, Phoenix, AZ 85004' }, true)).toMatchObject({
      ok: true,
      value: {
        property: { street: '12 Palm St', unit: 'Unit 4', city: 'Phoenix', state: 'AZ', zip: '85004' },
      },
    })
  })

  it('reads the equipment age, install year or a date', () => {
    const year = (equipmentAge: string) => {
      const result = read({ ...maria, ...palmSt, equipmentAge })
      return result.ok ? result.value.property?.equipmentYear : result.problems
    }
    expect(year('2014')).toBe(2014)
    expect(year('12')).toBe(2014)
    expect(year('12 years old')).toBe(2014)
    expect(year('0')).toBe(2026)
    expect(year('2014-05-01')).toBe(2014)
    expect(year('5/1/2014')).toBe(2014)
    expect(year('')).toBeNull()
    expect(year('unknown')).toEqual([AGE_UNREADABLE])
    expect(year('1949')).toEqual(['Check the equipment age'])
    expect(year('80')).toEqual(['Check the equipment age'])
  })

  it('lists every problem with the row', () => {
    expect(
      read({ name: '', phone: '555', email: 'nope', street: '12 Palm St', city: '', state: 'Zona', zip: '850' }),
    ).toEqual({
      ok: false,
      problems: [
        'Enter the customer’s name',
        'Enter a 10-digit phone number',
        'Enter a valid email address',
        'Enter the city',
        'Enter a 2-letter state, like AZ',
        'Enter a 5-digit ZIP code',
      ],
    })
  })

  it('refuses equipment without an address, and an address it can’t split', () => {
    expect(read({ ...maria, equipmentBrand: 'Carrier' })).toEqual({
      ok: false,
      problems: [EXTRAS_NEED_ADDRESS],
    })
    expect(read({ ...maria, address: 'Phoenix AZ' }, true)).toEqual({
      ok: false,
      problems: [ADDRESS_NOT_SPLIT],
    })
  })

  it('refuses notes that are too long', () => {
    expect(read({ ...maria, notes: 'x'.repeat(2001) })).toEqual({
      ok: false,
      problems: ['Keep the notes under 2,000 characters'],
    })
  })
})

describe('splitAddress', () => {
  it('splits street, unit, city, state and ZIP', () => {
    expect(splitAddress('12 Palm St, Phoenix, AZ 85004')).toEqual({
      street: '12 Palm St',
      unit: '',
      city: 'Phoenix',
      state: 'AZ',
      zip: '85004',
    })
    expect(splitAddress('12 Palm St, Apt 4, Phoenix, AZ, 85004-1234')).toEqual({
      street: '12 Palm St',
      unit: 'Apt 4',
      city: 'Phoenix',
      state: 'AZ',
      zip: '85004-1234',
    })
    expect(splitAddress('12 Palm St, Santa Fe, New Mexico 87501')).toEqual({
      street: '12 Palm St',
      unit: '',
      city: 'Santa Fe',
      state: 'New Mexico',
      zip: '87501',
    })
    expect(splitAddress('')).toEqual({ street: '', unit: '', city: '', state: '', zip: '' })
  })

  it('gives up on what doesn’t fit', () => {
    expect(splitAddress('12 Palm St Phoenix AZ 85004')).toBeUndefined()
    expect(splitAddress('12 Palm St, Phoenix')).toBeUndefined()
    expect(splitAddress('1, 2, 3, 4, AZ 85004')).toBeUndefined()
  })
})

describe('stateCode and cleanZip', () => {
  it('turns state names into codes', () => {
    expect(stateCode('Arizona')).toBe('AZ')
    expect(stateCode('new  mexico')).toBe('NM')
    expect(stateCode('District of Columbia')).toBe('DC')
    expect(stateCode('az')).toBe('az') // the state rule upper-cases codes itself
    expect(stateCode('Narnia')).toBe('Narnia')
  })

  it('cleans ZIP codes', () => {
    expect(cleanZip('85004-1234')).toBe('85004')
    expect(cleanZip('2134')).toBe('02134')
    expect(cleanZip('85004')).toBe('85004')
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/modules/customers/import-rows.test.ts`
Expected: FAIL (module `./import-rows.ts` doesn't exist).

- [ ] **Step 3: Export `CustomerNotes` from `customers.schemas.ts`**

In `relay-api/src/modules/customers/customers.schemas.ts`, directly after the `optionalText` function, add:

```ts
// A customer's notes. A blank box saves as nothing.
export const CustomerNotes = optionalText(2000, 'Keep the notes under 2,000 characters')
```

and in `CustomerChanges` replace `notes: optionalText(2000, 'Keep the notes under 2,000 characters'),` with `notes: CustomerNotes,`.

- [ ] **Step 4: Create `relay-api/src/modules/customers/imports.schemas.ts`**

```ts
import { z } from 'zod'

// What the web app sends for one spreadsheet row: its line number in the file and the text of
// each matched cell. Reading and checking the values is import-rows.ts's job.
const Cell = z.string().max(2000, 'A cell is over 2,000 characters').optional()

export const ImportRow = z.object({
  row: z.number().int().min(1),
  name: Cell,
  lastName: Cell,
  phone: Cell,
  email: Cell,
  street: Cell,
  unit: Cell,
  city: Cell,
  state: Cell,
  zip: Cell,
  address: Cell, // the whole address in one cell
  equipmentBrand: Cell,
  equipmentAge: Cell,
  accessNotes: Cell,
  notes: Cell,
})
export type ImportRow = z.infer<typeof ImportRow>
```

- [ ] **Step 5: Create `relay-api/src/modules/customers/import-rows.ts`**

```ts
import type { z } from 'zod'
import { CustomerNotes, NewCustomer, PropertyInput } from './customers.schemas.ts'
import type { ImportRow } from './imports.schemas.ts'

// Turning one spreadsheet row into a customer and an address, or into the reasons it can't be
// imported. Pure: no database. The contact and address rules are the customer screens' own
// (customers.schemas.ts); only the spreadsheet-specific reading lives here.

export const ADDRESS_NOT_SPLIT = 'Couldn’t split the address. Write it as street, city, ST ZIP'
export const AGE_UNREADABLE = 'Couldn’t read the equipment age or install year'
export const EXTRAS_NEED_ADDRESS = 'Equipment and access notes need an address'

export type ImportedCustomer = {
  name: string
  phone: string
  email?: string
  notes: string | null
}

export type ImportedProperty = {
  street: string
  unit: string | null
  city: string
  state: string
  zip: string
  equipmentBrand: string | null
  equipmentYear: number | null
  notes: string | null // access notes
}

export type ReadyRow = { customer: ImportedCustomer; property: ImportedProperty | null }
export type RowReading = { ok: true; value: ReadyRow } | { ok: false; problems: string[] }

type Address = { street: string; unit: string; city: string; state: string; zip: string }

export function readImportRow(
  row: ImportRow,
  addressInOneColumn: boolean,
  today = new Date(),
): RowReading {
  const problems: string[] = []
  const name = [text(row.name), text(row.lastName)].filter(Boolean).join(' ')
  const contact = NewCustomer.safeParse({ name, phone: text(row.phone), email: text(row.email) })
  if (!contact.success) problems.push(...messages(contact.error))
  const notes = CustomerNotes.safeParse(text(row.notes))
  if (!notes.success) problems.push(...messages(notes.error))
  const property = readProperty(row, addressInOneColumn, today, problems)
  if (!contact.success || !notes.success || problems.length > 0) return { ok: false, problems }
  return {
    ok: true,
    value: { customer: { ...contact.data, notes: notes.data ?? null }, property },
  }
}

// The address with its equipment and access notes, or null when the row has no address.
// Adds to `problems` when something can't be read.
function readProperty(
  row: ImportRow,
  addressInOneColumn: boolean,
  today: Date,
  problems: string[],
): ImportedProperty | null {
  const address: Address | undefined = addressInOneColumn
    ? splitAddress(text(row.address))
    : {
        street: text(row.street),
        unit: text(row.unit),
        city: text(row.city),
        state: text(row.state),
        zip: text(row.zip),
      }
  if (!address) {
    problems.push(ADDRESS_NOT_SPLIT)
    return null
  }
  const brand = text(row.equipmentBrand)
  const age = text(row.equipmentAge)
  const accessNotes = text(row.accessNotes)
  if (!Object.values(address).some(Boolean)) {
    if (brand || age || accessNotes) problems.push(EXTRAS_NEED_ADDRESS)
    return null
  }
  const equipmentYear = readInstallYear(age, today)
  if (equipmentYear === undefined) problems.push(AGE_UNREADABLE)
  const parsed = PropertyInput.safeParse({
    street: address.street,
    unit: address.unit || undefined,
    city: address.city,
    state: stateCode(address.state),
    zip: cleanZip(address.zip),
    equipmentBrand: brand,
    equipmentYear: equipmentYear ?? null,
    notes: accessNotes,
  })
  if (!parsed.success) {
    problems.push(...messages(parsed.error))
    return null
  }
  const value = parsed.data
  return {
    street: value.street,
    unit: value.unit || null,
    city: value.city,
    state: value.state,
    zip: value.zip,
    equipmentBrand: value.equipmentBrand ?? null,
    equipmentYear: value.equipmentYear ?? null,
    notes: value.notes ?? null,
  }
}

// '12 Palm St, Unit 4, Phoenix, AZ 85004' → its parts. The state and ZIP may share the last
// part or be two parts. A blank value is a blank address; anything else that doesn't fit is
// undefined.
export function splitAddress(value: string): Address | undefined {
  if (value === '') return { street: '', unit: '', city: '', state: '', zip: '' }
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
  const tail = stateAndZipOf(parts)
  if (!tail) return undefined
  const [street = '', second = '', third = ''] = tail.rest
  if (tail.rest.length === 2) {
    return { street, unit: '', city: second, state: tail.state, zip: tail.zip }
  }
  if (tail.rest.length === 3) {
    return { street, unit: second, city: third, state: tail.state, zip: tail.zip }
  }
  return undefined
}

// The state and ZIP at the end of an address, and the parts before them.
function stateAndZipOf(parts: string[]) {
  const last = parts[parts.length - 1] ?? ''
  const together = /^(.+?)\s+(\d{5}(?:-\d{4})?)$/.exec(last)
  if (together) {
    return { state: together[1] ?? '', zip: together[2] ?? '', rest: parts.slice(0, -1) }
  }
  if (/^\d{5}(?:-\d{4})?$/.test(last) && parts.length >= 4) {
    return { state: parts[parts.length - 2] ?? '', zip: last, rest: parts.slice(0, -2) }
  }
  return undefined
}

// 'Arizona' → 'AZ'. Anything else comes back as typed, for the state rule to judge.
export function stateCode(value: string): string {
  return STATE_CODES[value.toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim()] ?? value
}

// '85004-1234' → '85004'; '2134' (Excel dropped the leading 0) → '02134'.
export function cleanZip(value: string): string {
  const zipPlusFour = /^(\d{5})-\d{4}$/.exec(value)
  if (zipPlusFour) return zipPlusFour[1] ?? value
  if (/^\d{4}$/.test(value)) return `0${value}`
  return value
}

// The install year from what the sheet says: a year ('2014'), an age ('12', '12 years old'),
// or a date ('2014-05-01', '5/1/2014'). Blank is null; anything else is undefined. Whether the
// year is plausible is the address rule's call (PropertyInput).
function readInstallYear(value: string, today: Date): number | null | undefined {
  if (value === '') return null
  if (/^\d{4}$/.test(value)) return Number(value)
  const age = /^(\d{1,3})\s*(?:years?|yrs?)?(?:\s*old)?$/i.exec(value)
  if (age) return today.getFullYear() - Number(age[1])
  const date = /^(\d{4})-\d{1,2}-\d{1,2}$/.exec(value) ?? /^\d{1,2}\/\d{1,2}\/(\d{4})$/.exec(value)
  if (date) return Number(date[1])
  return undefined
}

function text(value: string | undefined): string {
  return (value ?? '').trim()
}

function messages(error: z.ZodError): string[] {
  return [...new Set(error.issues.map((issue) => issue.message))]
}

const STATE_CODES: Record<string, string> = {
  alabama: 'AL',
  alaska: 'AK',
  arizona: 'AZ',
  arkansas: 'AR',
  california: 'CA',
  colorado: 'CO',
  connecticut: 'CT',
  delaware: 'DE',
  'district of columbia': 'DC',
  florida: 'FL',
  georgia: 'GA',
  hawaii: 'HI',
  idaho: 'ID',
  illinois: 'IL',
  indiana: 'IN',
  iowa: 'IA',
  kansas: 'KS',
  kentucky: 'KY',
  louisiana: 'LA',
  maine: 'ME',
  maryland: 'MD',
  massachusetts: 'MA',
  michigan: 'MI',
  minnesota: 'MN',
  mississippi: 'MS',
  missouri: 'MO',
  montana: 'MT',
  nebraska: 'NE',
  nevada: 'NV',
  'new hampshire': 'NH',
  'new jersey': 'NJ',
  'new mexico': 'NM',
  'new york': 'NY',
  'north carolina': 'NC',
  'north dakota': 'ND',
  ohio: 'OH',
  oklahoma: 'OK',
  oregon: 'OR',
  pennsylvania: 'PA',
  'rhode island': 'RI',
  'south carolina': 'SC',
  'south dakota': 'SD',
  tennessee: 'TN',
  texas: 'TX',
  utah: 'UT',
  vermont: 'VT',
  virginia: 'VA',
  washington: 'WA',
  'west virginia': 'WV',
  wisconsin: 'WI',
  wyoming: 'WY',
}
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `npx vitest run src/modules/customers/import-rows.test.ts src/modules/customers/customers.test.ts`
Expected: PASS. If an expected problem list differs only in order or wording from a shared rule, check the shared rule's message in `customers.schemas.ts`/`lib/fields.ts` and fix the test only when the brief's expectation contradicts that message (report it).

- [ ] **Step 7: Typecheck, lint, commit**

```bash
npm run typecheck
npx biome check --write src/modules/customers
git add src/modules/customers
git commit -m "feat: read and check a spreadsheet row for import"
```

---

### Task 4: Check and save an import

**Files:**
- Modify: `relay-api/src/modules/customers/imports.schemas.ts` (append)
- Create: `relay-api/src/modules/customers/imports.queries.ts`, `imports.service.ts`, `imports.routes.ts`, `imports.test.ts`
- Modify: `relay-api/src/app.ts`

**Interfaces:**
- Consumes: `ImportRow`, `readImportRow`, `ReadyRow` (Task 3), `customerMatchKey` (Task 1), `customerImports`, `customers.importId` (Task 2).
- Produces:
  - `ImportCheck` `{ addressInOneColumn: boolean; rows: ImportRow[] }`, `ImportSave` (+ `fileName`), `IMPORT_ROW_LIMIT = 5000`
  - `POST /api/customers/imports/check` → `{ rows: [{ row, status, problems }], counts: { ready, existing, repeated, invalid } }`
  - `POST /api/customers/imports` → 201 `{ importId, created, existing, repeated, invalid }`
  - `importsRoutes` (Router), mounted before `customersRoutes`

- [ ] **Step 1: Write the failing tests**

`relay-api/src/modules/customers/imports.test.ts`:

```ts
import { eq } from 'drizzle-orm'
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'
import { createShop, resetDb, type Shop, signInTechnician } from '../../../test/helpers.ts'
import { createApp } from '../../app.ts'
import { db } from '../../db/client.ts'
import { consentEvents, customerImports, customers, properties } from '../../db/schema.ts'

const app = createApp()

beforeEach(resetDb)

function postAs(shop: Shop, path: string, body: object) {
  return request(app).post(path).set('Cookie', shop.cookie).send(body)
}

// createShop already has Maria Lopez, +16025550111.
const rows = [
  {
    row: 2,
    name: 'Tom',
    lastName: 'Reyes',
    phone: '602-555-0144',
    street: '88 W Main St',
    city: 'Mesa',
    state: 'Arizona',
    zip: '85201',
    equipmentBrand: 'Trane',
    equipmentAge: '10',
  },
  { row: 3, name: 'maria  lopez', phone: '(602) 555-0111' }, // already in Relay
  { row: 4, name: 'Tom Reyes', phone: '6025550144' }, // repeats row 2
  { row: 5, name: 'Ana Reyes', phone: '602-555-0144' }, // same phone, another person
  { row: 6, name: '', phone: '555' }, // needs fixing
]

describe('POST /api/customers/imports/check', () => {
  it('sorts every row and saves nothing', async () => {
    const shop = await createShop('desert')
    const res = await postAs(shop, '/api/customers/imports/check', { rows }).expect(200)
    expect(res.body.rows).toEqual([
      { row: 2, status: 'ready', problems: [] },
      { row: 3, status: 'existing', problems: [] },
      { row: 4, status: 'repeated', problems: [] },
      { row: 5, status: 'ready', problems: [] },
      {
        row: 6,
        status: 'invalid',
        problems: ['Enter the customer’s name', 'Enter a 10-digit phone number'],
      },
    ])
    expect(res.body.counts).toEqual({ ready: 2, existing: 1, repeated: 1, invalid: 1 })
    expect(await db.$count(customers)).toBe(1)
  })

  it('takes a whole 5,000-row file but not one row more', async () => {
    const shop = await createShop('desert')
    const many = (count: number) =>
      Array.from({ length: count }, (_, i) => ({
        row: i + 2,
        name: `Customer ${i}`,
        phone: '6025550199',
      }))
    const big = await postAs(shop, '/api/customers/imports/check', { rows: many(5000) }).expect(200)
    expect(big.body.counts.ready).toBe(5000)
    const tooBig = await postAs(shop, '/api/customers/imports/check', { rows: many(5001) }).expect(
      400,
    )
    expect(tooBig.body.error.details.rows).toEqual(['Import up to 5,000 rows at a time'])
  })

  it('is for the owner and office only', async () => {
    const shop = await createShop('desert')
    const cookie = await signInTechnician(shop.mike)
    await request(app)
      .post('/api/customers/imports/check')
      .set('Cookie', cookie)
      .send({ rows })
      .expect(403)
  })
})

describe('POST /api/customers/imports', () => {
  it('imports the ready rows as one batch, without texting consent', async () => {
    const shop = await createShop('desert')
    const res = await postAs(shop, '/api/customers/imports', {
      fileName: 'customers.xlsx',
      rows,
    }).expect(201)
    expect(res.body).toEqual({
      importId: expect.any(String),
      created: 2,
      existing: 1,
      repeated: 1,
      invalid: 1,
    })

    const [batch] = await db
      .select()
      .from(customerImports)
      .where(eq(customerImports.id, res.body.importId))
    expect(batch).toMatchObject({
      tenantId: shop.tenant.id,
      createdBy: shop.office.id,
      fileName: 'customers.xlsx',
      createdCount: 2,
      skippedCount: 3,
      keptCount: null,
      undoneAt: null,
    })

    const imported = await db.select().from(customers).where(eq(customers.importId, batch.id))
    expect(imported.map((customer) => customer.name).sort()).toEqual(['Ana Reyes', 'Tom Reyes'])
    expect(
      imported.every((customer) => customer.source === 'import' && customer.phone === '+16025550144'),
    ).toBe(true)

    const tom = imported.find((customer) => customer.name === 'Tom Reyes')!
    const [address] = await db.select().from(properties).where(eq(properties.customerId, tom.id))
    expect(address).toMatchObject({
      street: '88 W Main St',
      city: 'Mesa',
      state: 'AZ',
      zip: '85201',
      equipmentBrand: 'Trane',
      equipmentYear: new Date().getFullYear() - 10,
    })
    expect(await db.$count(consentEvents)).toBe(0)
  })

  it('imports nothing the second time the same file comes in', async () => {
    const shop = await createShop('desert')
    await postAs(shop, '/api/customers/imports', { fileName: 'customers.xlsx', rows }).expect(201)
    const again = await postAs(shop, '/api/customers/imports', {
      fileName: 'customers.xlsx',
      rows,
    }).expect(422)
    expect(again.body.error).toEqual({
      code: 'nothing_to_import',
      message: 'Nothing to import: no row is ready.',
    })
    expect(await db.$count(customerImports)).toBe(1)
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/modules/customers/imports.test.ts`
Expected: FAIL (routes return 404).

- [ ] **Step 3: Append to `imports.schemas.ts`**

```ts
export const IMPORT_ROW_LIMIT = 5000

export const ImportCheck = z.object({
  addressInOneColumn: z.boolean().default(false),
  rows: z
    .array(ImportRow)
    .min(1, 'The file has no rows to import')
    .max(IMPORT_ROW_LIMIT, 'Import up to 5,000 rows at a time'),
})
export type ImportCheck = z.infer<typeof ImportCheck>

export const ImportSave = ImportCheck.extend({
  fileName: z.string().trim().min(1, 'Name the file').max(200),
})
export type ImportSave = z.infer<typeof ImportSave>
```

- [ ] **Step 4: Create `relay-api/src/modules/customers/imports.queries.ts`**

```ts
import { and, eq, inArray } from 'drizzle-orm'
import type { Db } from '../../db/client.ts'
import { customerImports, customers, properties } from '../../db/schema.ts'
import type { ReadyRow } from './import-rows.ts'

// Tenant-scoped: every query takes tenantId first.

// Rows go in 500 at a time, well under Postgres's limit on query parameters.
const CHUNK = 500

// This contractor's customers with any of these phone numbers, to spot ones already in Relay.
export function listCustomersByPhones(tenantId: string, phones: string[], tx: Db) {
  if (phones.length === 0) return Promise.resolve([])
  return tx
    .select({ phone: customers.phone, name: customers.name })
    .from(customers)
    .where(and(eq(customers.tenantId, tenantId), inArray(customers.phone, phones)))
}

export async function insertImport(
  tenantId: string,
  values: Omit<typeof customerImports.$inferInsert, 'tenantId'>,
  tx: Db,
) {
  const [batch] = await tx
    .insert(customerImports)
    .values({ ...values, tenantId })
    .returning()
  return batch
}

// Saves the ready rows as customers of this import, with their addresses.
export async function insertImportedCustomers(
  tenantId: string,
  importId: string,
  rows: ReadyRow[],
  tx: Db,
) {
  for (let start = 0; start < rows.length; start += CHUNK) {
    const chunk = rows.slice(start, start + CHUNK)
    // Postgres returns the inserted rows in the order of VALUES, so ids line up with the chunk.
    const inserted = await tx
      .insert(customers)
      .values(
        chunk.map(({ customer }) => ({ ...customer, tenantId, importId, source: 'import' as const })),
      )
      .returning({ id: customers.id })
    const addresses = chunk.flatMap(({ property }, index) =>
      property ? [{ ...property, tenantId, customerId: inserted[index]!.id }] : [],
    )
    if (addresses.length > 0) await tx.insert(properties).values(addresses)
  }
}
```

- [ ] **Step 5: Create `relay-api/src/modules/customers/imports.service.ts`**

```ts
import { type Db, db } from '../../db/client.ts'
import { HttpError } from '../../lib/http-error.ts'
import type { SessionUser } from '../accounts/accounts.service.ts'
import { tenantOf } from '../booking/booking.service.ts'
import { customerMatchKey } from './customer-match.ts'
import { type ReadyRow, readImportRow } from './import-rows.ts'
import * as queries from './imports.queries.ts'
import type { ImportCheck, ImportSave } from './imports.schemas.ts'

type RowStatus = 'ready' | 'existing' | 'repeated' | 'invalid'
type SortedRow = { row: number; status: RowStatus; problems: string[]; ready?: ReadyRow }

// Reads every row and sorts it: ready to import, already in Relay (same phone and name),
// repeated earlier in the file, or invalid with the reasons.
async function sortRows(tenantId: string, input: ImportCheck, tx: Db): Promise<SortedRow[]> {
  const readings = input.rows.map((row) => ({
    row: row.row,
    reading: readImportRow(row, input.addressInOneColumn),
  }))
  const phones = [
    ...new Set(
      readings.flatMap(({ reading }) => (reading.ok ? [reading.value.customer.phone] : [])),
    ),
  ]
  const inRelay = new Set(
    (await queries.listCustomersByPhones(tenantId, phones, tx)).map((customer) =>
      customerMatchKey(customer.phone ?? '', customer.name),
    ),
  )
  const seen = new Set<string>()
  return readings.map(({ row, reading }): SortedRow => {
    if (!reading.ok) return { row, status: 'invalid', problems: reading.problems }
    const key = customerMatchKey(reading.value.customer.phone, reading.value.customer.name)
    if (inRelay.has(key)) return { row, status: 'existing', problems: [] }
    if (seen.has(key)) return { row, status: 'repeated', problems: [] }
    seen.add(key)
    return { row, status: 'ready', problems: [], ready: reading.value }
  })
}

function countByStatus(rows: SortedRow[]) {
  const counts = { ready: 0, existing: 0, repeated: 0, invalid: 0 }
  for (const row of rows) counts[row.status] += 1
  return counts
}

// The office's preview: what would happen to each row. Saves nothing.
export async function check(tenantId: string, input: ImportCheck) {
  const rows = await sortRows(tenantId, input, db)
  return { rows: rows.map(({ ready: _, ...row }) => row), counts: countByStatus(rows) }
}

// Imports the ready rows as one batch. Sorts the rows again instead of trusting the preview,
// since customers may have been added in between.
export async function save(user: SessionUser, input: ImportSave) {
  const tenantId = tenantOf(user)
  return db.transaction(async (tx) => {
    const rows = await sortRows(tenantId, input, tx)
    const ready = rows.flatMap((row) => (row.ready ? [row.ready] : []))
    if (ready.length === 0) {
      throw new HttpError(422, 'nothing_to_import', 'Nothing to import: no row is ready.')
    }
    const counts = countByStatus(rows)
    const batch = await queries.insertImport(
      tenantId,
      {
        createdBy: user.id,
        fileName: input.fileName,
        createdCount: ready.length,
        skippedCount: rows.length - ready.length,
      },
      tx,
    )
    await queries.insertImportedCustomers(tenantId, batch.id, ready, tx)
    return {
      importId: batch.id,
      created: counts.ready,
      existing: counts.existing,
      repeated: counts.repeated,
      invalid: counts.invalid,
    }
  })
}
```

- [ ] **Step 6: Create `relay-api/src/modules/customers/imports.routes.ts`**

```ts
import { Router } from 'express'
import { requireRole } from '../../middleware/auth.ts'
import { tenantOf } from '../booking/booking.service.ts'
import { ImportCheck, ImportSave } from './imports.schemas.ts'
import * as imports from './imports.service.ts'

// Spreadsheet import. Mounted before customersRoutes so '/customers/imports' is never read as
// a customer id; app.ts gives these routes a 5 MB body limit.
export const importsRoutes = Router()

const staff = requireRole('owner', 'office')

importsRoutes.post('/customers/imports/check', staff, async (req, res) => {
  const input = ImportCheck.parse(req.body)
  res.json(await imports.check(tenantOf(req.user!), input))
})

importsRoutes.post('/customers/imports', staff, async (req, res) => {
  const input = ImportSave.parse(req.body)
  res.status(201).json(await imports.save(req.user!, input))
})
```

- [ ] **Step 7: Wire it into `relay-api/src/app.ts`**

1. Add `import { importsRoutes } from './modules/customers/imports.routes.ts'` (Biome sorts imports).
2. Directly before the line `app.use(express.json())`, add:

```ts
  // A spreadsheet import sends up to 5,000 rows at once; every other route keeps the default
  // limit. The default parser below skips bodies this one already read.
  app.use('/api/customers/imports', express.json({ limit: '5mb' }))
```

3. In the `app.use('/api', …)` list, put `importsRoutes,` on the line directly before `customersRoutes,`, with the comment `// before customersRoutes: '/customers/imports' isn't a customer id` above it.

- [ ] **Step 8: Run the tests to see them pass, then the whole suite**

Run: `npx vitest run src/modules/customers/imports.test.ts`
Expected: PASS (5 tests).
Run: `npx vitest run`
Expected: all pass.

- [ ] **Step 9: Typecheck, lint, commit**

```bash
npm run typecheck
npx biome check --write src/modules/customers src/app.ts
git add src/modules/customers src/app.ts
git commit -m "feat: check and import customers from spreadsheet rows"
```

---

### Task 5: List and undo imports

**Files:**
- Modify: `relay-api/src/modules/customers/imports.schemas.ts`, `imports.queries.ts`, `imports.service.ts`, `imports.routes.ts`, `imports.test.ts`

**Interfaces:**
- Consumes: Task 4's files and `customerImports`.
- Produces:
  - `GET /api/customers/imports` → `{ imports: [{ id, fileName, createdByName, createdCount, skippedCount, keptCount, createdAt, undoneAt }] }` (latest 20, newest first)
  - `POST /api/customers/imports/:importId/undo` → `{ removed, kept }`; 404 `That import wasn’t found.`; 409 `This import was already undone.`

- [ ] **Step 1: Write the failing tests**

In `imports.test.ts`, add `createJob` to the helpers import, then append:

```ts
describe('GET /api/customers/imports', () => {
  it('lists the latest imports with who ran them', async () => {
    const shop = await createShop('desert')
    await postAs(shop, '/api/customers/imports', { fileName: 'customers.xlsx', rows }).expect(201)
    const res = await request(app)
      .get('/api/customers/imports')
      .set('Cookie', shop.cookie)
      .expect(200)
    expect(res.body.imports).toEqual([
      {
        id: expect.any(String),
        fileName: 'customers.xlsx',
        createdByName: shop.office.name,
        createdCount: 2,
        skippedCount: 3,
        keptCount: null,
        createdAt: expect.any(String),
        undoneAt: null,
      },
    ])
  })
})

describe('POST /api/customers/imports/:importId/undo', () => {
  it('removes the imported customers, keeping one who has a job', async () => {
    const shop = await createShop('desert')
    const saved = await postAs(shop, '/api/customers/imports', {
      fileName: 'customers.xlsx',
      rows,
    }).expect(201)
    const [tom] = await db.select().from(customers).where(eq(customers.name, 'Tom Reyes'))
    const [tomAddress] = await db
      .select()
      .from(properties)
      .where(eq(properties.customerId, tom.id))
    await createJob(shop, { customerId: tom.id, propertyId: tomAddress.id })

    const res = await postAs(shop, `/api/customers/imports/${saved.body.importId}/undo`, {}).expect(
      200,
    )
    expect(res.body).toEqual({ removed: 1, kept: 1 })
    const left = await db
      .select()
      .from(customers)
      .where(eq(customers.importId, saved.body.importId))
    expect(left.map((customer) => customer.name)).toEqual(['Tom Reyes'])
    const [batch] = await db.select().from(customerImports)
    expect(batch).toMatchObject({ undoneAt: expect.any(Date), keptCount: 1 })

    const again = await postAs(
      shop,
      `/api/customers/imports/${saved.body.importId}/undo`,
      {},
    ).expect(409)
    expect(again.body.error.message).toBe('This import was already undone.')
  })

  it('can’t undo another contractor’s import', async () => {
    const shop = await createShop('desert')
    const other = await createShop('other')
    const saved = await postAs(other, '/api/customers/imports', { fileName: 'x.csv', rows }).expect(
      201,
    )
    const res = await postAs(shop, `/api/customers/imports/${saved.body.importId}/undo`, {}).expect(
      404,
    )
    expect(res.body.error.message).toBe('That import wasn’t found.')
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/modules/customers/imports.test.ts`
Expected: FAIL. The GET may answer 400 or 404 (no route yet; `/customers/:customerId` must not catch it once Task 4's mount order is in place), and undo answers 404.

- [ ] **Step 3: Append to `imports.schemas.ts`**

```ts
export const ImportParams = z.object({ importId: z.uuid('That import link isn’t valid') })
```

- [ ] **Step 4: Append to `imports.queries.ts`**

Change the imports to:

```ts
import { and, desc, eq, exists, inArray, not, or } from 'drizzle-orm'
import { type Db, db, type Tx } from '../../db/client.ts'
import {
  calls,
  customerImports,
  customers,
  jobs,
  messages,
  paymentMethods,
  properties,
  users,
  waitlistEntries,
} from '../../db/schema.ts'
import type { ReadyRow } from './import-rows.ts'
```

Append:

```ts
// The latest imports, newest first, with the name of who ran each.
export function listImports(tenantId: string, limit: number) {
  return db
    .select({
      id: customerImports.id,
      fileName: customerImports.fileName,
      createdByName: users.name,
      createdCount: customerImports.createdCount,
      skippedCount: customerImports.skippedCount,
      keptCount: customerImports.keptCount,
      createdAt: customerImports.createdAt,
      undoneAt: customerImports.undoneAt,
    })
    .from(customerImports)
    .leftJoin(users, eq(users.id, customerImports.createdBy))
    .where(eq(customerImports.tenantId, tenantId))
    .orderBy(desc(customerImports.createdAt))
    .limit(limit)
}

// Locks the import until the transaction ends, so two undos can't run at once.
export async function lockImport(tenantId: string, importId: string, tx: Tx) {
  const [batch] = await tx
    .select()
    .from(customerImports)
    .where(and(eq(customerImports.tenantId, tenantId), eq(customerImports.id, importId)))
    .for('update')
  return batch
}

// A customer with any history in Relay since the import: a job, call, text, waitlist entry or
// saved card. Undo keeps these.
const hasHistory = or(
  exists(
    db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.tenantId, customers.tenantId), eq(jobs.customerId, customers.id))),
  ),
  exists(
    db
      .select({ id: calls.id })
      .from(calls)
      .where(and(eq(calls.tenantId, customers.tenantId), eq(calls.customerId, customers.id))),
  ),
  exists(
    db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.tenantId, customers.tenantId), eq(messages.customerId, customers.id))),
  ),
  exists(
    db
      .select({ id: waitlistEntries.id })
      .from(waitlistEntries)
      .where(
        and(
          eq(waitlistEntries.tenantId, customers.tenantId),
          eq(waitlistEntries.customerId, customers.id),
        ),
      ),
  ),
  exists(
    db
      .select({ id: paymentMethods.id })
      .from(paymentMethods)
      .where(
        and(
          eq(paymentMethods.tenantId, customers.tenantId),
          eq(paymentMethods.customerId, customers.id),
        ),
      ),
  ),
)!

// Removes the import's customers that have no history, with their addresses. Returns how many.
export async function removeImportedCustomers(tenantId: string, importId: string, tx: Tx) {
  const removable = await tx
    .select({ id: customers.id })
    .from(customers)
    .where(
      and(eq(customers.tenantId, tenantId), eq(customers.importId, importId), not(hasHistory)),
    )
  const ids = removable.map((customer) => customer.id)
  if (ids.length === 0) return 0
  await tx
    .delete(properties)
    .where(and(eq(properties.tenantId, tenantId), inArray(properties.customerId, ids)))
  await tx.delete(customers).where(and(eq(customers.tenantId, tenantId), inArray(customers.id, ids)))
  return ids.length
}

export function countImportedCustomers(tenantId: string, importId: string, tx: Tx) {
  return tx.$count(
    customers,
    and(eq(customers.tenantId, tenantId), eq(customers.importId, importId)),
  )
}

export async function markUndone(tenantId: string, importId: string, keptCount: number, tx: Tx) {
  await tx
    .update(customerImports)
    .set({ undoneAt: new Date(), keptCount })
    .where(and(eq(customerImports.tenantId, tenantId), eq(customerImports.id, importId)))
}
```

(If the schema's export for the waitlist or payment-method table has a different name, use the real export name from `src/db/schema.ts`.)

- [ ] **Step 5: Append to `imports.service.ts`**

```ts
// Past imports shows this many.
const IMPORTS_SHOWN = 20

export async function list(tenantId: string) {
  return { imports: await queries.listImports(tenantId, IMPORTS_SHOWN) }
}

// Takes an import back: removes the customers it added, except any with history since.
export async function undo(tenantId: string, importId: string) {
  return db.transaction(async (tx) => {
    const batch = await queries.lockImport(tenantId, importId, tx)
    if (!batch) throw new HttpError(404, 'not_found', 'That import wasn’t found.')
    if (batch.undoneAt) {
      throw new HttpError(409, 'already_undone', 'This import was already undone.')
    }
    const removed = await queries.removeImportedCustomers(tenantId, importId, tx)
    const kept = await queries.countImportedCustomers(tenantId, importId, tx)
    await queries.markUndone(tenantId, importId, kept, tx)
    return { removed, kept }
  })
}
```

- [ ] **Step 6: Append to `imports.routes.ts`**

Add `ImportParams` to the schema import, then:

```ts
importsRoutes.get('/customers/imports', staff, async (req, res) => {
  res.json(await imports.list(tenantOf(req.user!)))
})

importsRoutes.post('/customers/imports/:importId/undo', staff, async (req, res) => {
  const { importId } = ImportParams.parse(req.params)
  res.json(await imports.undo(tenantOf(req.user!), importId))
})
```

- [ ] **Step 7: Run the tests, then the whole suite**

Run: `npx vitest run src/modules/customers/imports.test.ts`
Expected: PASS (8 tests).
Run: `npx vitest run`
Expected: all pass (including `GET /api/customers/:customerId`, which must still work for real ids).

- [ ] **Step 8: Typecheck, lint, commit**

```bash
npm run typecheck
npx biome check --write src/modules/customers
git add src/modules/customers
git commit -m "feat: list customer imports and undo one"
```

---

### Task 6: Column guessing and row building (relay-web)

**Files:**
- Create: `relay-web/src/features/customers/import/fields.ts`, `guess-columns.ts`, `guess-columns.test.ts`, `to-rows.ts`, `to-rows.test.ts`, `problem-rows.ts`, `problem-rows.test.ts`

**Interfaces:**
- Produces:
  - `IMPORT_FIELDS`, `type ImportField`, `type ColumnChoice = Partial<Record<ImportField, number>>`, `FIELD_LABELS`, `SEPARATE_ADDRESS_FIELDS`
  - `guessColumns(headings: string[]): { columns: ColumnChoice; addressInOneColumn: boolean }`
  - `switchAddressMode(columns: ColumnChoice, oneColumn: boolean): ColumnChoice`
  - `type ImportRowInput = { row: number } & Partial<Record<ImportField, string>>`
  - `cellText(value: unknown): string`, `headingRowIndex(grid)`, `headings(grid)`, `dataRowCount(grid)`, `sampleValue(grid, column)`, `toRows(grid, columns): ImportRowInput[]`
  - `problemRowsCsv(grid: string[][], rows: { row: number; problems: string[] }[]): string`

- [ ] **Step 1: Create `relay-web/src/features/customers/import/fields.ts`**

```ts
// The Relay fields a spreadsheet column can fill, in the order the Columns step lists them.
// relay-api reads the same names (relay-api src/modules/customers/imports.schemas.ts).
export const IMPORT_FIELDS = [
  'name',
  'lastName',
  'phone',
  'email',
  'street',
  'unit',
  'city',
  'state',
  'zip',
  'address',
  'equipmentBrand',
  'equipmentAge',
  'accessNotes',
  'notes',
] as const
export type ImportField = (typeof IMPORT_FIELDS)[number]

// Which column of the file fills each field, by its index. A missing field isn't imported.
export type ColumnChoice = Partial<Record<ImportField, number>>

export const FIELD_LABELS: Record<ImportField, string> = {
  name: 'Name (or first name)',
  lastName: 'Last name (if separate)',
  phone: 'Phone',
  email: 'Email',
  street: 'Street',
  unit: 'Unit',
  city: 'City',
  state: 'State',
  zip: 'ZIP',
  address: 'Address',
  equipmentBrand: 'Equipment brand',
  equipmentAge: 'Equipment age or install year',
  accessNotes: 'Access notes',
  notes: 'Customer notes',
}

// The address when it's in separate columns; 'address' is the one-column alternative.
export const SEPARATE_ADDRESS_FIELDS = ['street', 'unit', 'city', 'state', 'zip'] as const
```

- [ ] **Step 2: Write the failing tests**

`relay-web/src/features/customers/import/guess-columns.test.ts`:

```ts
import { expect, it } from 'vitest'
import { guessColumns, switchAddressMode } from './guess-columns'

it('matches headings ignoring case, spaces and punctuation', () => {
  expect(
    guessColumns(['Customer Name', 'E-mail Address', 'Phone #', 'Street Address', 'City', 'State', 'Zip Code']),
  ).toEqual({
    columns: { name: 0, email: 1, phone: 2, street: 3, city: 4, state: 5, zip: 6 },
    addressInOneColumn: false,
  })
})

it('prefers a mobile number and keeps first and last names', () => {
  expect(guessColumns(['First Name', 'Last Name', 'Home Phone', 'Phone', 'Mobile']).columns).toEqual({
    name: 0,
    lastName: 1,
    phone: 4,
  })
})

it('takes a lone address column as the whole address', () => {
  expect(guessColumns(['Name', 'Phone', 'Address'])).toEqual({
    columns: { name: 0, phone: 1, address: 2 },
    addressInOneColumn: true,
  })
})

it('uses each column once and leaves unknown headings out', () => {
  expect(
    guessColumns(['Name', 'Customer', 'Balance', 'Notes', 'Gate code', 'Brand', 'Age']).columns,
  ).toEqual({ name: 0, notes: 3, accessNotes: 4, equipmentBrand: 5, equipmentAge: 6 })
})

it('moves the address between one column and separate columns', () => {
  expect(switchAddressMode({ name: 0, street: 2, city: 3, zip: 4 }, true)).toEqual({
    name: 0,
    address: 2,
  })
  expect(switchAddressMode({ name: 0, address: 2 }, false)).toEqual({ name: 0, street: 2 })
})
```

`relay-web/src/features/customers/import/to-rows.test.ts`:

```ts
import { expect, it } from 'vitest'
import { cellText, dataRowCount, headingRowIndex, headings, sampleValue, toRows } from './to-rows'

const grid = [
  ['', '', ''],
  ['Name', 'Phone', 'Balance'],
  ['Maria Lopez', '6025550111', '20'],
  ['', '', ''],
  ['', '', '15'],
  ['Tom Reyes', '', ''],
]

it('turns cells into text', () => {
  expect(cellText(4805550199)).toBe('4805550199')
  expect(cellText(new Date(Date.UTC(2014, 4, 1)))).toBe('2014-05-01')
  expect(cellText(null)).toBe('')
  expect(cellText('  Maria ')).toBe('Maria')
  expect(cellText(true)).toBe('true')
})

it('finds the heading row and counts the customers under it', () => {
  expect(headingRowIndex(grid)).toBe(1)
  expect(headings(grid)).toEqual(['Name', 'Phone', 'Balance'])
  expect(dataRowCount(grid)).toBe(3)
  expect(dataRowCount([])).toBe(0)
})

it('shows a sample from each column', () => {
  expect(sampleValue(grid, 1)).toBe('6025550111')
  expect(sampleValue(grid, 2)).toBe('20')
})

it('sends only matched cells, with file line numbers, skipping rows with nothing matched', () => {
  expect(toRows(grid, { name: 0, phone: 1 })).toEqual([
    { row: 3, name: 'Maria Lopez', phone: '6025550111' },
    { row: 6, name: 'Tom Reyes' },
  ])
})
```

`relay-web/src/features/customers/import/problem-rows.test.ts`:

```ts
import { expect, it } from 'vitest'
import { problemRowsCsv } from './problem-rows'

it('keeps the heading and the rows to fix, adding the problem', () => {
  const grid = [
    ['Name', 'Phone'],
    ['Maria, Jr', '555'],
    ['Tom "TJ" Reyes', ''],
  ]
  expect(
    problemRowsCsv(grid, [
      { row: 2, problems: ['Enter a 10-digit phone number'] },
      { row: 3, problems: ['A', 'B'] },
    ]),
  ).toBe(
    '﻿Name,Phone,Problem\r\n"Maria, Jr",555,Enter a 10-digit phone number\r\n"Tom ""TJ"" Reyes",,A; B\r\n',
  )
})
```

- [ ] **Step 3: Run them to see them fail**

Run: `npx vitest run src/features/customers/import`
Expected: FAIL (modules missing).

- [ ] **Step 4: Write `relay-web/src/features/customers/import/guess-columns.ts`**

```ts
import { type ColumnChoice, type ImportField, SEPARATE_ADDRESS_FIELDS } from './fields'

// Headings Relay recognises for each field, written without spaces or punctuation. 'address'
// (one column) isn't guessed by heading; see guessColumns.
const ALIASES: Record<Exclude<ImportField, 'address'>, string[]> = {
  name: ['name', 'customer', 'customername', 'fullname', 'client', 'clientname', 'contact', 'contactname', 'firstname', 'first'],
  lastName: ['lastname', 'last', 'surname', 'familyname'],
  phone: ['phone', 'phonenumber', 'mobile', 'mobilephone', 'cell', 'cellphone', 'telephone', 'tel', 'primaryphone'],
  email: ['email', 'emailaddress'],
  street: ['address', 'street', 'streetaddress', 'address1', 'addressline1', 'serviceaddress'],
  unit: ['unit', 'apt', 'apartment', 'suite', 'address2', 'addressline2'],
  city: ['city', 'town'],
  state: ['state', 'st', 'province'],
  zip: ['zip', 'zipcode', 'postalcode', 'postcode'],
  equipmentBrand: ['brand', 'equipment', 'equipmentbrand', 'systembrand', 'make'],
  equipmentAge: ['installyear', 'yearinstalled', 'installed', 'equipmentyear', 'equipmentage', 'systemage', 'age'],
  accessNotes: ['gatecode', 'access', 'accessnotes'],
  notes: ['notes', 'note', 'comments', 'memo'],
}

// 'E-mail Address' → 'emailaddress'
function normalize(heading: string): string {
  return heading.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function isMobile(normalized: string): boolean {
  return normalized.includes('mobile') || normalized.includes('cell')
}

// Relay's first guess at which column fills each field, from the file's headings. Each column
// is used once. Among several phone columns a mobile or cell one wins. An address column with
// no city, state or ZIP column is taken as the whole address in one column.
export function guessColumns(headings: string[]): {
  columns: ColumnChoice
  addressInOneColumn: boolean
} {
  const names = headings.map(normalize)
  const used = new Set<number>()
  let columns: ColumnChoice = {}
  for (const field of Object.keys(ALIASES) as (keyof typeof ALIASES)[]) {
    const matches = names.flatMap((name, index) =>
      ALIASES[field].includes(name) && !used.has(index) ? [index] : [],
    )
    if (field === 'phone') {
      matches.sort((a, b) => Number(isMobile(names[b] ?? '')) - Number(isMobile(names[a] ?? '')))
    }
    const index = matches[0]
    if (index !== undefined) {
      columns[field] = index
      used.add(index)
    }
  }
  const addressInOneColumn =
    columns.street !== undefined &&
    columns.city === undefined &&
    columns.state === undefined &&
    columns.zip === undefined
  if (addressInOneColumn) columns = switchAddressMode(columns, true)
  return { columns, addressInOneColumn }
}

// The same choice with the address moved to one column (from Street) or back to separate
// columns (into Street).
export function switchAddressMode(columns: ColumnChoice, oneColumn: boolean): ColumnChoice {
  const next = { ...columns }
  if (oneColumn) {
    const street = next.street
    for (const field of SEPARATE_ADDRESS_FIELDS) delete next[field]
    if (next.address === undefined && street !== undefined) next.address = street
  } else {
    const address = next.address
    delete next.address
    if (next.street === undefined && address !== undefined) next.street = address
  }
  return next
}
```

- [ ] **Step 5: Write `relay-web/src/features/customers/import/to-rows.ts`**

```ts
import { type ColumnChoice, IMPORT_FIELDS, type ImportField } from './fields'

// One spreadsheet row as relay-api's import reads it: its line number in the file and the
// text of each matched cell.
export type ImportRowInput = { row: number } & Partial<Record<ImportField, string>>

// A cell as text: numbers as their digits, Excel dates as 'YYYY-MM-DD', empty cells as ''.
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10)
  }
  return String(value).trim()
}

function isBlank(cells: string[]): boolean {
  return cells.every((cell) => cell === '')
}

// The heading row: the first row with anything in it. -1 for an empty sheet.
export function headingRowIndex(grid: string[][]): number {
  return grid.findIndex((cells) => !isBlank(cells))
}

export function headings(grid: string[][]): string[] {
  return grid[headingRowIndex(grid)] ?? []
}

// How many customers the sheet holds: non-blank rows under the heading row.
export function dataRowCount(grid: string[][]): number {
  const heading = headingRowIndex(grid)
  if (heading === -1) return 0
  return grid.slice(heading + 1).filter((cells) => !isBlank(cells)).length
}

// The first value under the heading in this column, shown next to a column choice.
export function sampleValue(grid: string[][], column: number): string {
  const heading = headingRowIndex(grid)
  return (
    grid
      .slice(heading + 1)
      .map((cells) => cells[column] ?? '')
      .find((cell) => cell !== '') ?? ''
  )
}

// The rows to send: one per row under the heading with at least one matched cell filled, with
// only the matched cells. `row` is the line number in the file, as the office sees it.
export function toRows(grid: string[][], columns: ColumnChoice): ImportRowInput[] {
  const heading = headingRowIndex(grid)
  if (heading === -1) return []
  const rows: ImportRowInput[] = []
  grid.forEach((cells, index) => {
    if (index <= heading) return
    const row: ImportRowInput = { row: index + 1 }
    let filled = false
    for (const field of IMPORT_FIELDS) {
      const column = columns[field]
      if (column === undefined) continue
      const value = cells[column] ?? ''
      if (value !== '') {
        row[field] = value
        filled = true
      }
    }
    if (filled) rows.push(row)
  })
  return rows
}
```

- [ ] **Step 6: Write `relay-web/src/features/customers/import/problem-rows.ts`**

```ts
import { headingRowIndex } from './to-rows'

// The rows that need fixing as a CSV the office can fix and import later: the file's heading
// row and those rows as they were, with a "Problem" column added. It starts with a byte-order
// mark so Excel opens it as UTF-8.
export function problemRowsCsv(
  grid: string[][],
  rows: { row: number; problems: string[] }[],
): string {
  const lines = [[...(grid[headingRowIndex(grid)] ?? []), 'Problem']]
  for (const { row, problems } of rows) lines.push([...(grid[row - 1] ?? []), problems.join('; ')])
  return `﻿${lines.map((cells) => cells.map(csvCell).join(',')).join('\r\n')}\r\n`
}

// Quotes a cell holding a comma, quote or line break: 'say "hi"' → '"say ""hi"""'.
function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}
```

- [ ] **Step 7: Run the tests to see them pass**

Run: `npx vitest run src/features/customers/import`
Expected: PASS.

- [ ] **Step 8: Typecheck, lint, commit**

```bash
npm run typecheck
npx biome check --write src/features/customers/import
git add src/features/customers/import
git commit -m "feat: guess import columns and build rows from a sheet"
```

---

### Task 7: Reading the file, wording, and import API hooks (relay-web)

**Files:**
- Modify: `relay-web/package.json`, `relay-web/package-lock.json`
- Create: `relay-web/src/features/customers/import/read-file.ts`, `read-file.test.ts`, `labels.ts`, `labels.test.ts`, `api.ts`

**Interfaces:**
- Consumes: `cellText` (Task 6), `ImportRowInput` (Task 6).
- Produces:
  - `type SheetGrid = { name: string; rows: string[][] }`, `readSpreadsheet(file: File): Promise<SheetGrid[]>`, `class FileReadError`, `ROW_LIMIT = 5000`, `rowCountProblem(count: number): string | null`
  - labels: `customersCount(n)`, `importButtonLabel(ready)`, `doneSummary(saved)`, `undoWarning(created)`, `undoneNotice({ removed, kept })`, `pastImportLine(item)`, `undoneLine(item)`, `STATUS_LABELS`
  - hooks: `useCheckImport()`, `useSaveImport()`, `usePastImports()`, `useUndoImport()`; types `RowStatus`, `CheckResult`, `SavedImport`, `PastImport`, `ImportInput`

- [ ] **Step 1: Add the parsers**

```bash
cd relay-web
npm install papaparse@^5.5.3 read-excel-file@^9.3.10
npm install -D @types/papaparse@^5.5.2
```

- [ ] **Step 2: Write the failing tests**

`relay-web/src/features/customers/import/read-file.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { FileReadError, readSpreadsheet, rowCountProblem } from './read-file'

describe('readSpreadsheet', () => {
  it('reads a CSV, dropping a byte-order mark and keeping quoted commas', async () => {
    const file = new File(['﻿Name,Phone\r\n"Lopez, Maria",6025550111\r\n'], 'customers.csv')
    expect(await readSpreadsheet(file)).toEqual([
      { name: 'customers.csv', rows: [['Name', 'Phone'], ['Lopez, Maria', '6025550111'], ['']] },
    ])
  })

  it('refuses other file types and files over 5 MB', async () => {
    await expect(readSpreadsheet(new File(['x'], 'customers.pdf'))).rejects.toThrow(
      'This file couldn’t be read. Save it as .xlsx or .csv and try again.',
    )
    const big = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'big.csv')
    await expect(readSpreadsheet(big)).rejects.toBeInstanceOf(FileReadError)
    await expect(readSpreadsheet(big)).rejects.toThrow(
      'This file is over 5 MB. Split it into smaller files.',
    )
  })
})

it('says when a sheet has no customers or too many', () => {
  expect(rowCountProblem(0)).toBe('This file has no customers under the heading row.')
  expect(rowCountProblem(7200)).toBe(
    'This file has 7,200 rows. Split it into files of up to 5,000.',
  )
  expect(rowCountProblem(5000)).toBeNull()
})
```

Note on the first test: papaparse turns the final line break into one empty row (`['']`); the rest of the app skips blank rows, so the reader returns it as it is.

`relay-web/src/features/customers/import/labels.test.ts`:

```ts
import { expect, it } from 'vitest'
import {
  customersCount,
  doneSummary,
  importButtonLabel,
  pastImportLine,
  undoneLine,
  undoneNotice,
  undoWarning,
} from './labels'

const past = {
  id: 'i1',
  fileName: 'customers.xlsx',
  createdByName: 'Desert Office',
  createdCount: 1180,
  skippedCount: 60,
  keptCount: null,
  createdAt: '2026-10-03T12:00:00.000Z',
  undoneAt: null,
}

it('counts customers', () => {
  expect(customersCount(1)).toBe('1 customer')
  expect(customersCount(1180)).toBe('1,180 customers')
  expect(importButtonLabel(1180)).toBe('Import 1,180 customers')
})

it('sums up a finished import, leaving out zeros', () => {
  expect(doneSummary({ importId: 'i1', created: 1180, existing: 42, repeated: 6, invalid: 12 })).toBe(
    '1,180 customers imported. 42 were already in Relay, 6 were repeated in the file, 12 need fixing.',
  )
  expect(doneSummary({ importId: 'i1', created: 1, existing: 0, repeated: 0, invalid: 0 })).toBe(
    '1 customer imported.',
  )
})

it('words undo', () => {
  expect(undoWarning(1180)).toBe(
    'Remove the 1,180 customers this import added? Anyone you’ve booked a job for since then stays. Changes made to the others since the import are lost.',
  )
  expect(undoneNotice({ removed: 1177, kept: 3 })).toBe(
    'Removed 1,177 customers. 3 kept because they have jobs.',
  )
  expect(undoneNotice({ removed: 2, kept: 0 })).toBe('Removed 2 customers.')
})

it('describes a past import', () => {
  expect(pastImportLine(past)).toBe('Oct 3, 2026 · Desert Office · 1,180 customers')
  expect(pastImportLine({ ...past, createdByName: null })).toBe('Oct 3, 2026 · 1,180 customers')
  expect(undoneLine({ ...past, undoneAt: '2026-10-04T12:00:00.000Z', keptCount: 3 })).toBe(
    'Undone Oct 4, 2026 · 3 kept (have jobs)',
  )
  expect(undoneLine({ ...past, undoneAt: '2026-10-04T12:00:00.000Z', keptCount: 0 })).toBe(
    'Undone Oct 4, 2026',
  )
})
```

- [ ] **Step 3: Run them to see them fail**

Run: `npx vitest run src/features/customers/import/read-file.test.ts src/features/customers/import/labels.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 4: Write `relay-web/src/features/customers/import/read-file.ts`**

```ts
import { cellText } from './to-rows'

// Reading a .csv or .xlsx file in the browser into sheets of text cells. The parsers are
// loaded only here, so the rest of the app doesn't carry them.

export type SheetGrid = { name: string; rows: string[][] }

export class FileReadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FileReadError'
  }
}

const MAX_FILE_BYTES = 5 * 1024 * 1024
// relay-api's limit too (relay-api src/modules/customers/imports.schemas.ts IMPORT_ROW_LIMIT).
export const ROW_LIMIT = 5000
const UNREADABLE = 'This file couldn’t be read. Save it as .xlsx or .csv and try again.'

export async function readSpreadsheet(file: File): Promise<SheetGrid[]> {
  if (file.size > MAX_FILE_BYTES) {
    throw new FileReadError('This file is over 5 MB. Split it into smaller files.')
  }
  const name = file.name.toLowerCase()
  try {
    if (name.endsWith('.csv')) {
      const { default: Papa } = await import('papaparse')
      const text = (await file.text()).replace(/^﻿/, '')
      const parsed = Papa.parse<string[]>(text)
      return [{ name: file.name, rows: parsed.data.map((cells) => cells.map(cellText)) }]
    }
    if (name.endsWith('.xlsx')) {
      const { default: readXlsxFile } = await import('read-excel-file/browser')
      const sheets = await readXlsxFile(file)
      return sheets.map((sheet) => ({
        name: sheet.sheet,
        rows: sheet.data.map((cells) => cells.map(cellText)),
      }))
    }
  } catch {
    throw new FileReadError(UNREADABLE)
  }
  throw new FileReadError(UNREADABLE)
}

// What's wrong with a sheet's number of customers, or null when it can be imported.
export function rowCountProblem(count: number): string | null {
  if (count === 0) return 'This file has no customers under the heading row.'
  if (count > ROW_LIMIT) {
    return `This file has ${count.toLocaleString('en-US')} rows. Split it into files of up to 5,000.`
  }
  return null
}
```

- [ ] **Step 5: Write `relay-web/src/features/customers/import/api.ts`**

```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { api } from '@/lib/api'
import type { ImportRowInput } from './to-rows'

export const ROW_STATUSES = ['ready', 'existing', 'repeated', 'invalid'] as const
export type RowStatus = (typeof ROW_STATUSES)[number]

const CheckResult = z.object({
  rows: z.array(
    z.object({ row: z.number(), status: z.enum(ROW_STATUSES), problems: z.array(z.string()) }),
  ),
  counts: z.object({
    ready: z.number(),
    existing: z.number(),
    repeated: z.number(),
    invalid: z.number(),
  }),
})
export type CheckResult = z.infer<typeof CheckResult>

const SavedImport = z.object({
  importId: z.string(),
  created: z.number(),
  existing: z.number(),
  repeated: z.number(),
  invalid: z.number(),
})
export type SavedImport = z.infer<typeof SavedImport>

const PastImport = z.object({
  id: z.string(),
  fileName: z.string(),
  createdByName: z.string().nullable(),
  createdCount: z.number(),
  skippedCount: z.number(),
  keptCount: z.number().nullable(),
  createdAt: z.string(),
  undoneAt: z.string().nullable(),
})
export type PastImport = z.infer<typeof PastImport>

const PastImports = z.object({ imports: z.array(PastImport) })
const Undone = z.object({ removed: z.number(), kept: z.number() })
export type Undone = z.infer<typeof Undone>

export type ImportInput = { addressInOneColumn: boolean; rows: ImportRowInput[] }

const importsKey = ['customers', 'imports']

export function useCheckImport() {
  return useMutation({
    mutationFn: (input: ImportInput) => api.post('/customers/imports/check', input, CheckResult),
  })
}

// Importing or undoing changes the customer list, Past imports and the book-job search.
function useRefreshAfterImport() {
  const queryClient = useQueryClient()
  return () => {
    queryClient.invalidateQueries({ queryKey: ['customers'] })
    queryClient.invalidateQueries({ queryKey: ['dispatch'] })
  }
}

export function useSaveImport() {
  const refresh = useRefreshAfterImport()
  return useMutation({
    mutationFn: (input: ImportInput & { fileName: string }) =>
      api.post('/customers/imports', input, SavedImport),
    onSuccess: refresh,
  })
}

export function usePastImports() {
  return useQuery({
    queryKey: importsKey,
    queryFn: () => api.get('/customers/imports', PastImports),
    select: (data) => data.imports,
  })
}

export function useUndoImport() {
  const refresh = useRefreshAfterImport()
  return useMutation({
    mutationFn: (importId: string) => api.post(`/customers/imports/${importId}/undo`, {}, Undone),
    onSuccess: refresh,
  })
}
```

- [ ] **Step 6: Write `relay-web/src/features/customers/import/labels.ts`**

```ts
import type { PastImport, RowStatus, SavedImport, Undone } from './api'

const day = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

// '1 customer', '1,180 customers'
export function customersCount(count: number): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? 'customer' : 'customers'}`
}

// 'Import 1,180 customers'
export function importButtonLabel(ready: number): string {
  return `Import ${customersCount(ready)}`
}

// '1,180 customers imported. 42 were already in Relay, 6 were repeated in the file, 12 need
// fixing.' Parts that are zero are left out.
export function doneSummary(saved: SavedImport): string {
  const skipped = [
    saved.existing > 0 && `${saved.existing.toLocaleString('en-US')} were already in Relay`,
    saved.repeated > 0 && `${saved.repeated.toLocaleString('en-US')} were repeated in the file`,
    saved.invalid > 0 && `${saved.invalid.toLocaleString('en-US')} need fixing`,
  ].filter(Boolean)
  const imported = `${customersCount(saved.created)} imported.`
  return skipped.length > 0 ? `${imported} ${skipped.join(', ')}.` : imported
}

export function undoWarning(created: number): string {
  return `Remove the ${customersCount(created)} this import added? Anyone you’ve booked a job for since then stays. Changes made to the others since the import are lost.`
}

// 'Removed 1,177 customers. 3 kept because they have jobs.'
export function undoneNotice({ removed, kept }: Undone): string {
  const removedText = `Removed ${customersCount(removed)}.`
  return kept > 0 ? `${removedText} ${kept.toLocaleString('en-US')} kept because they have jobs.` : removedText
}

// 'Oct 3, 2026 · Desert Office · 1,180 customers'
export function pastImportLine(item: PastImport): string {
  return [day.format(new Date(item.createdAt)), item.createdByName, customersCount(item.createdCount)]
    .filter(Boolean)
    .join(' · ')
}

// 'Undone Oct 4, 2026 · 3 kept (have jobs)'
export function undoneLine(item: PastImport): string {
  const undone = `Undone ${day.format(new Date(item.undoneAt ?? item.createdAt))}`
  return item.keptCount ? `${undone} · ${item.keptCount.toLocaleString('en-US')} kept (have jobs)` : undone
}

// Status chips in the Check step use fixed meaning colors, like dispatch's.
export const STATUS_LABELS: Record<RowStatus, { label: string; chip: string }> = {
  ready: { label: 'Ready', chip: 'bg-emerald-100 text-emerald-900' },
  existing: { label: 'Already in Relay', chip: 'bg-slate-100 text-slate-700' },
  repeated: { label: 'Repeated in this file', chip: 'bg-slate-100 text-slate-700' },
  invalid: { label: 'Needs fixing', chip: 'bg-amber-100 text-amber-900' },
}
```

(`labels.ts` imports only types from `api.ts`, so the node-run tests never load the browser API client.)

- [ ] **Step 7: Run the tests to see them pass**

Run: `npx vitest run src/features/customers/import`
Expected: PASS. If papaparse returns a different trailing row than `['']` for the CSV test, adjust only that expectation to papaparse's real output and say so in the report.

- [ ] **Step 8: Typecheck, build, lint, commit**

```bash
npm run typecheck
npm run build
npx biome check --write src/features/customers/import
git add package.json package-lock.json src/features/customers/import
git commit -m "feat: read import files and add the import api hooks"
```

`npm run build` must show the parsers in their own chunks, not in the main bundle.

---

### Task 8: Import page with the File step and Past imports (relay-web)

**Files:**
- Create: `relay-web/src/features/customers/import/step-bar.tsx`, `file-step.tsx`, `past-imports.tsx`
- Create: `relay-web/src/routes/customers-import.tsx`
- Modify: `relay-web/src/router.tsx`, `relay-web/src/routes/customers.tsx` (Import buttons)

**Interfaces:**
- Consumes: `readSpreadsheet`, `FileReadError`, `rowCountProblem`, `SheetGrid` (Task 7); `dataRowCount`, `headings` (Task 6); `guessColumns` (Task 6); `usePastImports`, `useUndoImport`, labels (Task 7); `ConfirmDialog`, `Confirmation` (`@/components/confirm-dialog`).
- Produces:
  - `type ImportStep = 'file' | 'columns' | 'check' | 'done'`, `<StepBar step />`
  - `type PickedFile = { fileName: string; sheets: SheetGrid[]; sheet: number }`, `<FileStep onPicked />`
  - `<PastImports />`
  - `CustomersImportPage` at `/customers/import`, holding: `step`, `picked`, `columns`, `addressInOneColumn`, `checked`, `saved`. Tasks 9–10 add the Columns, Check and Done steps into this page.

- [ ] **Step 1: Write `step-bar.tsx`**

```tsx
import { cn } from 'cn'
import { Check } from 'lucide-react'

const STEPS = [
  { id: 'file', label: 'File' },
  { id: 'columns', label: 'Columns' },
  { id: 'check', label: 'Check' },
  { id: 'done', label: 'Done' },
] as const
export type ImportStep = (typeof STEPS)[number]['id']

// Where the office is in the import. Not clickable: steps can't be skipped.
export function StepBar({ step }: { step: ImportStep }) {
  const current = STEPS.findIndex((candidate) => candidate.id === step)
  return (
    <ol aria-label="Import steps" className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
      {STEPS.map((item, index) => (
        <li
          key={item.id}
          aria-current={index === current ? 'step' : undefined}
          className={cn(
            'flex items-center gap-2',
            index === current ? 'font-semibold' : index > current && 'text-muted-foreground',
          )}
        >
          <span
            className={cn(
              'flex size-6 items-center justify-center rounded-full border text-xs',
              index === current && 'border-primary bg-primary text-primary-foreground',
              index < current && 'border-primary text-primary',
            )}
          >
            {index < current ? <Check className="size-3.5" aria-hidden /> : index + 1}
          </span>
          {item.label}
        </li>
      ))}
    </ol>
  )
}
```

- [ ] **Step 2: Write `past-imports.tsx`**

```tsx
import { useState } from 'react'
import { toast } from 'sonner'
import { type Confirmation, ConfirmDialog } from '@/components/confirm-dialog'
import { Button } from '@/components/ui/button'
import { errorMessage } from '@/lib/errors'
import { type PastImport, usePastImports, useUndoImport } from './api'
import { pastImportLine, undoneLine, undoneNotice, undoWarning } from './labels'

// The latest imports, each with Undo until it's undone. Hidden when there are none.
export function PastImports() {
  const imports = usePastImports()
  const undo = useUndoImport()
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)

  if (!imports.data || imports.data.length === 0) return null

  function askToUndo(item: PastImport) {
    setConfirmation({
      title: 'Undo this import?',
      message: undoWarning(item.createdCount),
      confirmLabel: 'Undo import',
      destructive: true,
      onConfirm: () =>
        undo.mutate(item.id, {
          onSuccess: (result) => toast.success(undoneNotice(result)),
          onError: (error) => toast.error(errorMessage(error)),
        }),
    })
  }

  return (
    <section className="space-y-2">
      <h2 className="font-semibold">Past imports</h2>
      <ul className="divide-y rounded-xl border bg-card">
        {imports.data.map((item) => (
          <li
            key={item.id}
            className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm"
          >
            <div className="min-w-0">
              <p className="truncate font-medium">{item.fileName}</p>
              <p className="text-muted-foreground">{pastImportLine(item)}</p>
            </div>
            {item.undoneAt ? (
              <span className="text-muted-foreground">{undoneLine(item)}</span>
            ) : (
              <Button variant="outline" size="sm" onClick={() => askToUndo(item)}>
                Undo
              </Button>
            )}
          </li>
        ))}
      </ul>
      <ConfirmDialog confirmation={confirmation} onClose={() => setConfirmation(null)} />
    </section>
  )
}
```

- [ ] **Step 3: Write `file-step.tsx`**

```tsx
import { cn } from 'cn'
import { FileSpreadsheet } from 'lucide-react'
import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { PastImports } from './past-imports'
import { FileReadError, readSpreadsheet, rowCountProblem, type SheetGrid } from './read-file'
import { dataRowCount } from './to-rows'

export type PickedFile = { fileName: string; sheets: SheetGrid[]; sheet: number }

const UNREADABLE = 'This file couldn’t be read. Save it as .xlsx or .csv and try again.'

// Step 1: choose or drop a .csv or .xlsx. The first sheet must have between 1 and 5,000
// customers; another sheet can be picked in the next step.
export function FileStep({ onPicked }: { onPicked: (picked: PickedFile) => void }) {
  const [error, setError] = useState<string | null>(null)
  const [reading, setReading] = useState(false)
  const [dragging, setDragging] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  async function read(file: File) {
    setError(null)
    setReading(true)
    try {
      const sheets = await readSpreadsheet(file)
      const problem = rowCountProblem(dataRowCount(sheets[0]?.rows ?? []))
      if (problem) setError(problem)
      else onPicked({ fileName: file.name, sheets, sheet: 0 })
    } catch (caught) {
      setError(caught instanceof FileReadError ? caught.message : UNREADABLE)
    } finally {
      setReading(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: dropping a file is an extra; the button below does the same with the keyboard */}
      <div
        onDragOver={(event) => {
          event.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault()
          setDragging(false)
          const file = event.dataTransfer.files[0]
          if (file) read(file)
        }}
        className={cn(
          'space-y-3 rounded-xl border-2 border-dashed bg-card p-8 text-center',
          dragging && 'border-primary bg-primary/5',
        )}
      >
        <FileSpreadsheet className="mx-auto size-8 text-muted-foreground" aria-hidden />
        <p className="font-medium">Drop your spreadsheet here</p>
        <p className="mx-auto max-w-md text-sm text-muted-foreground">
          Export your customer list from Excel, Google Sheets or your old software: one customer
          per row, with a heading row. A .xlsx or .csv file, up to 5,000 customers.
        </p>
        <input
          ref={input}
          id="import-file"
          type="file"
          accept=".csv,.xlsx"
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) read(file)
          }}
        />
        <Button size="lg" disabled={reading} onClick={() => input.current?.click()}>
          {reading ? 'Reading file…' : 'Choose file'}
        </Button>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
      <PastImports />
    </div>
  )
}
```

If Biome reports that `biome-ignore` comment as unused or as naming an unknown rule, delete the comment. If instead it flags the drop zone under a different a11y rule name, put that rule's name in the comment.

- [ ] **Step 4: Write `relay-web/src/routes/customers-import.tsx`**

```tsx
import { ChevronLeft } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { StaffPage } from '@/components/staff-layout'
import type { CheckResult, SavedImport } from '@/features/customers/import/api'
import { FileStep, type PickedFile } from '@/features/customers/import/file-step'
import type { ColumnChoice } from '@/features/customers/import/fields'
import { guessColumns } from '@/features/customers/import/guess-columns'
import { type ImportStep, StepBar } from '@/features/customers/import/step-bar'
import { headings } from '@/features/customers/import/to-rows'

// Importing customers from a spreadsheet: File, Columns, Check, Done. Nothing is saved before
// the Check step's import button, so leaving the page drops the unsaved import.
export function CustomersImportPage() {
  const [step, setStep] = useState<ImportStep>('file')
  const [picked, setPicked] = useState<PickedFile | null>(null)
  const [columns, setColumns] = useState<ColumnChoice>({})
  const [addressInOneColumn, setAddressInOneColumn] = useState(false)
  const [checked, setChecked] = useState<CheckResult | null>(null)
  const [saved, setSaved] = useState<SavedImport | null>(null)

  // Picking a file (or another sheet in it) starts from Relay's guess for its headings.
  function pick(next: PickedFile) {
    const guess = guessColumns(headings(next.sheets[next.sheet]?.rows ?? []))
    setPicked(next)
    setColumns(guess.columns)
    setAddressInOneColumn(guess.addressInOneColumn)
    setChecked(null)
    setStep('columns')
  }

  function startOver() {
    setPicked(null)
    setColumns({})
    setAddressInOneColumn(false)
    setChecked(null)
    setSaved(null)
    setStep('file')
  }

  return (
    <StaffPage title="Import customers">
      <Link
        to="/customers"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:underline"
      >
        <ChevronLeft className="size-4" aria-hidden /> Customers
      </Link>
      <StepBar step={step} />
      {step === 'file' && <FileStep onPicked={pick} />}
    </StaffPage>
  )
}
```

`columns`, `addressInOneColumn`, `checked`, `saved` and `startOver` are used by the steps Tasks 9–10 add. Until then Biome may warn that some of them are unused: that's expected. Leave them as written (don't rename or delete them) and mention the warning in the report.

- [ ] **Step 5: Add the route**

In `relay-web/src/router.tsx`, import `CustomersImportPage` from `@/routes/customers-import` (sorted) and add `{ path: '/customers/import', element: <CustomersImportPage /> },` directly before the `/customers/:customerId` route.

- [ ] **Step 6: Add the Import buttons to the list**

In `relay-web/src/routes/customers.tsx`:

1. Add `Upload` to the `lucide-react` import, `buttonVariants` to the `@/components/ui/button` import, and `import { cn } from 'cn'`.
2. In the header, directly before the **Add customer** button, add:

```tsx
          <Link
            to="/customers/import"
            className={cn(buttonVariants({ variant: 'outline', size: 'lg' }))}
          >
            <Upload aria-hidden /> Import
          </Link>
```

3. In the "No customers yet" state, wrap the existing **Add customer** button so the two sit side by side:

```tsx
          <div className="flex flex-wrap justify-center gap-2">
            <Button onClick={() => setAdding({ mode: 'add' })}>
              <Plus /> Add customer
            </Button>
            <Link to="/customers/import" className={cn(buttonVariants({ variant: 'outline' }))}>
              <Upload aria-hidden /> Import a spreadsheet
            </Link>
          </div>
```

- [ ] **Step 7: Typecheck, tests, build, lint, encoding check, commit**

```bash
npm run typecheck
npx vitest run
npm run build
npx biome check --write src/features/customers/import src/routes/customers-import.tsx src/routes/customers.tsx src/router.tsx
for f in src/features/customers/import/*.tsx src/routes/customers-import.tsx src/routes/customers.tsx; do head -c3 "$f" | od -c | head -1; grep -c "â€" "$f"; done
git add src/features/customers/import src/routes/customers-import.tsx src/routes/customers.tsx src/router.tsx
git commit -m "feat: add the import page with the file step and past imports"
```

The encoding loop must show no `357 273 277` and `0` for every file.

---

### Task 9: Columns step (relay-web)

**Files:**
- Create: `relay-web/src/features/customers/import/columns-step.tsx`
- Modify: `relay-web/src/routes/customers-import.tsx`

**Interfaces:**
- Consumes: `PickedFile` (Task 8), `ColumnChoice`, `FIELD_LABELS`, `ImportField`, `SEPARATE_ADDRESS_FIELDS` (Task 6), `switchAddressMode` (Task 6), `headings`, `sampleValue`, `toRows`, `dataRowCount` (Task 6), `rowCountProblem` (Task 7), `useCheckImport`, `CheckResult` (Task 7).
- Produces: `<ColumnsStep picked columns addressInOneColumn onSheet onColumns onAddressMode onBack onChecked />`.

- [ ] **Step 1: Write `columns-step.tsx`**

```tsx
import { type ReactNode, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/native-select'
import { errorMessage } from '@/lib/errors'
import { type CheckResult, useCheckImport } from './api'
import { type ColumnChoice, FIELD_LABELS, type ImportField } from './fields'
import type { PickedFile } from './file-step'
import { rowCountProblem } from './read-file'
import { dataRowCount, headings, sampleValue, toRows } from './to-rows'

const CONTACT: ImportField[] = ['name', 'lastName', 'phone', 'email']
const SEPARATE_ADDRESS: ImportField[] = ['street', 'unit', 'city', 'state', 'zip']
const EQUIPMENT: ImportField[] = ['equipmentBrand', 'equipmentAge', 'accessNotes']
const REQUIRED: ImportField[] = ['name', 'phone']

// Step 2: which column of the file fills each Relay field, starting from Relay's guess.
export function ColumnsStep({
  picked,
  columns,
  addressInOneColumn,
  onSheet,
  onColumns,
  onAddressMode,
  onBack,
  onChecked,
}: {
  picked: PickedFile
  columns: ColumnChoice
  addressInOneColumn: boolean
  onSheet: (sheet: number) => void
  onColumns: (columns: ColumnChoice) => void
  onAddressMode: (oneColumn: boolean) => void
  onBack: () => void
  onChecked: (result: CheckResult) => void
}) {
  const check = useCheckImport()
  const [error, setError] = useState<string | null>(null)
  const grid = picked.sheets[picked.sheet]?.rows ?? []
  const fileHeadings = headings(grid)
  const sheetProblem = rowCountProblem(dataRowCount(grid))
  const used = new Set(Object.values(columns))
  const unused = fileHeadings.filter((heading, index) => heading !== '' && !used.has(index))
  const rows = toRows(grid, columns)
  const ready =
    columns.name !== undefined && columns.phone !== undefined && sheetProblem === null

  function runCheck() {
    setError(null)
    check.mutate(
      { addressInOneColumn, rows },
      { onSuccess: onChecked, onError: (caught) => setError(errorMessage(caught)) },
    )
  }

  const row = (field: ImportField) => (
    <ColumnRow
      key={field}
      field={field}
      required={REQUIRED.includes(field)}
      headings={fileHeadings}
      grid={grid}
      value={columns[field]}
      onChange={(column) => {
        const next = { ...columns }
        if (column === undefined) delete next[field]
        else next[field] = column
        onColumns(next)
      }}
    />
  )

  return (
    <div className="space-y-6">
      {picked.sheets.length > 1 && (
        <div className="max-w-xs space-y-1.5">
          <Label htmlFor="import-sheet">Sheet</Label>
          <NativeSelect
            id="import-sheet"
            value={picked.sheet}
            onChange={(event) => onSheet(Number(event.target.value))}
          >
            {picked.sheets.map((sheet, index) => (
              <option key={sheet.name} value={index}>
                {sheet.name}
              </option>
            ))}
          </NativeSelect>
        </div>
      )}
      {sheetProblem && (
        <p role="alert" className="text-sm text-destructive">
          {sheetProblem}
        </p>
      )}

      <Group title="Contact">{CONTACT.map(row)}</Group>

      <Group title="Address">
        <fieldset className="flex flex-wrap gap-x-6 gap-y-2 px-4 py-3 text-sm">
          <legend className="sr-only">Address is in</legend>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="address-mode"
              checked={!addressInOneColumn}
              onChange={() => onAddressMode(false)}
            />
            Separate columns
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="address-mode"
              checked={addressInOneColumn}
              onChange={() => onAddressMode(true)}
            />
            One column (&ldquo;12 Palm St, Phoenix, AZ 85004&rdquo;)
          </label>
        </fieldset>
        {addressInOneColumn ? row('address') : SEPARATE_ADDRESS.map(row)}
      </Group>

      <Group title="Equipment and access">{EQUIPMENT.map(row)}</Group>
      <Group title="Notes">{row('notes')}</Group>

      {unused.length > 0 && (
        <p className="text-sm text-muted-foreground">Not imported: {unused.join(', ')}</p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="flex flex-wrap justify-between gap-2">
        <Button variant="outline" size="lg" onClick={onBack}>
          Choose another file
        </Button>
        <Button size="lg" disabled={!ready || check.isPending} onClick={runCheck}>
          {check.isPending
            ? `Checking ${rows.length.toLocaleString('en-US')} rows…`
            : 'Check rows'}
        </Button>
      </div>
    </div>
  )
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="font-semibold">{title}</h2>
      <div className="divide-y rounded-xl border bg-card">{children}</div>
    </section>
  )
}

function ColumnRow({
  field,
  required,
  headings,
  grid,
  value,
  onChange,
}: {
  field: ImportField
  required: boolean
  headings: string[]
  grid: string[][]
  value: number | undefined
  onChange: (column: number | undefined) => void
}) {
  const id = `import-column-${field}`
  const sample = value === undefined ? '' : sampleValue(grid, value)
  return (
    <div className="grid gap-1.5 px-4 py-3 sm:grid-cols-[14rem_minmax(0,1fr)] sm:items-center">
      <Label htmlFor={id}>
        {FIELD_LABELS[field]}
        {required && <span className="text-destructive"> *</span>}
      </Label>
      <div className="min-w-0 space-y-1">
        <NativeSelect
          id={id}
          value={value ?? ''}
          onChange={(event) =>
            onChange(event.target.value === '' ? undefined : Number(event.target.value))
          }
        >
          <option value="">Don&rsquo;t import</option>
          {headings.map((heading, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a file's columns never reorder
            <option key={index} value={index}>
              {heading || `Column ${index + 1}`}
            </option>
          ))}
        </NativeSelect>
        {sample && <p className="truncate text-xs text-muted-foreground">e.g. {sample}</p>}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Put the step into the page**

In `relay-web/src/routes/customers-import.tsx`:

1. Import `ColumnsStep` from `@/features/customers/import/columns-step` and `switchAddressMode` from `@/features/customers/import/guess-columns`.
2. Below `{step === 'file' && …}` add:

```tsx
      {step === 'columns' && picked && (
        <ColumnsStep
          picked={picked}
          columns={columns}
          addressInOneColumn={addressInOneColumn}
          onSheet={(sheet) => pick({ ...picked, sheet })}
          onColumns={setColumns}
          onAddressMode={(oneColumn) => {
            setAddressInOneColumn(oneColumn)
            setColumns(switchAddressMode(columns, oneColumn))
          }}
          onBack={startOver}
          onChecked={(result) => {
            setChecked(result)
            setStep('check')
          }}
        />
      )}
```

Remove the temporary "used by the … steps" comment if Task 8 added it for these names.

- [ ] **Step 3: Typecheck, tests, build, lint, encoding check, commit**

```bash
npm run typecheck
npx vitest run
npm run build
npx biome check --write src/features/customers/import/columns-step.tsx src/routes/customers-import.tsx
for f in src/features/customers/import/columns-step.tsx src/routes/customers-import.tsx; do head -c3 "$f" | od -c | head -1; grep -c "â€" "$f"; done
git add src/features/customers/import/columns-step.tsx src/routes/customers-import.tsx
git commit -m "feat: let the office match spreadsheet columns before checking"
```

---

### Task 10: Check and Done steps (relay-web)

**Files:**
- Create: `relay-web/src/features/customers/import/check-step.tsx`, `relay-web/src/features/customers/import/done-step.tsx`
- Modify: `relay-web/src/routes/customers-import.tsx`

**Interfaces:**
- Consumes: `CheckResult`, `RowStatus`, `SavedImport`, `useSaveImport`, `useUndoImport` (Task 7); `STATUS_LABELS`, `importButtonLabel`, `doneSummary`, `undoWarning`, `undoneNotice` (Task 7); `ImportRowInput`, `toRows` (Task 6); `problemRowsCsv` (Task 6).
- Produces: `<CheckStep fileName grid rows result addressInOneColumn onBack onSaved />`, `<DoneStep saved onAnother />`.

- [ ] **Step 1: Write `check-step.tsx`**

```tsx
import { Download } from 'lucide-react'
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { errorMessage } from '@/lib/errors'
import { type CheckResult, type RowStatus, type SavedImport, useSaveImport } from './api'
import { importButtonLabel, STATUS_LABELS } from './labels'
import { problemRowsCsv } from './problem-rows'
import type { ImportRowInput } from './to-rows'

// The table shows this many rows of the chosen filter; the counts cover all of them.
const SHOWN = 200

type Filter = RowStatus | 'all'

// Step 3: what will happen to each row. Only ready rows are imported.
export function CheckStep({
  fileName,
  grid,
  rows,
  result,
  addressInOneColumn,
  onBack,
  onSaved,
}: {
  fileName: string
  grid: string[][]
  rows: ImportRowInput[]
  result: CheckResult
  addressInOneColumn: boolean
  onBack: () => void
  onSaved: (saved: SavedImport) => void
}) {
  const save = useSaveImport()
  const [filter, setFilter] = useState<Filter>('all')
  const [error, setError] = useState<string | null>(null)
  const byNumber = new Map(rows.map((row) => [row.row, row]))
  const filtered = result.rows.filter((row) => filter === 'all' || row.status === filter)
  const toFix = result.rows.filter((row) => row.status === 'invalid')

  function runImport() {
    setError(null)
    save.mutate(
      { fileName, addressInOneColumn, rows },
      { onSuccess: onSaved, onError: (caught) => setError(errorMessage(caught)) },
    )
  }

  function downloadRowsToFix() {
    const csv = problemRowsCsv(grid, toFix)
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `${fileName.replace(/\.[^.]+$/, '')}-rows-to-fix.csv`
    link.click()
    URL.revokeObjectURL(url)
  }

  const filters: { id: Filter; label: string; count: number }[] = [
    { id: 'all', label: 'All rows', count: result.rows.length },
    { id: 'ready', label: 'ready', count: result.counts.ready },
    { id: 'existing', label: 'already in Relay', count: result.counts.existing },
    { id: 'repeated', label: 'repeated in this file', count: result.counts.repeated },
    { id: 'invalid', label: 'need fixing', count: result.counts.invalid },
  ]

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {filters
          .filter((item) => item.id === 'all' || item.id === 'ready' || item.count > 0)
          .map((item) => (
            <Button
              key={item.id}
              variant={filter === item.id ? 'default' : 'outline'}
              size="sm"
              aria-pressed={filter === item.id}
              onClick={() => setFilter(item.id)}
            >
              {item.id === 'all' ? item.label : `${item.count.toLocaleString('en-US')} ${item.label}`}
            </Button>
          ))}
      </div>

      <ul className="divide-y overflow-hidden rounded-xl border bg-card">
        {filtered.slice(0, SHOWN).map((checked) => {
          const row = byNumber.get(checked.row)
          const status = STATUS_LABELS[checked.status]
          return (
            <li
              key={checked.row}
              className="grid gap-1 px-4 py-3 text-sm md:grid-cols-[4rem_minmax(0,1fr)_minmax(0,1.4fr)_auto] md:items-start md:gap-4"
            >
              <span className="text-muted-foreground">Row {checked.row}</span>
              <span className="min-w-0">
                <span className="block truncate font-medium">
                  {[row?.name, row?.lastName].filter(Boolean).join(' ') || 'No name'}
                </span>
                <span className="block text-muted-foreground">{row?.phone || 'No phone'}</span>
              </span>
              <span className="min-w-0 truncate text-muted-foreground">{addressOf(row)}</span>
              <span className="space-y-1 md:text-right">
                <Badge className={status.chip}>{status.label}</Badge>
                {checked.problems.map((problem) => (
                  <span key={problem} className="block text-xs text-amber-900">
                    {problem}
                  </span>
                ))}
              </span>
            </li>
          )
        })}
      </ul>
      {filtered.length > SHOWN && (
        <p className="text-sm text-muted-foreground">
          Showing the first {SHOWN} of {filtered.length.toLocaleString('en-US')} rows.
        </p>
      )}

      {toFix.length > 0 && (
        <Button variant="outline" onClick={downloadRowsToFix}>
          <Download aria-hidden /> Download rows to fix
        </Button>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="flex flex-wrap justify-between gap-2">
        <Button variant="outline" size="lg" onClick={onBack}>
          Back to columns
        </Button>
        <Button size="lg" disabled={result.counts.ready === 0 || save.isPending} onClick={runImport}>
          {save.isPending ? 'Importing…' : importButtonLabel(result.counts.ready)}
        </Button>
      </div>
    </div>
  )
}

// One line of address for the table: the one-column address, or street and city.
function addressOf(row: ImportRowInput | undefined): string {
  if (!row) return ''
  return row.address ?? [row.street, row.city].filter(Boolean).join(', ')
}
```

- [ ] **Step 2: Write `done-step.tsx`**

```tsx
import { cn } from 'cn'
import { useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { type Confirmation, ConfirmDialog } from '@/components/confirm-dialog'
import { Button, buttonVariants } from '@/components/ui/button'
import { errorMessage } from '@/lib/errors'
import { type SavedImport, type Undone, useUndoImport } from './api'
import { doneSummary, undoneNotice, undoWarning } from './labels'

// Step 4: what was imported, with the way back.
export function DoneStep({ saved, onAnother }: { saved: SavedImport; onAnother: () => void }) {
  const undo = useUndoImport()
  const [undone, setUndone] = useState<Undone | null>(null)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)

  function askToUndo() {
    setConfirmation({
      title: 'Undo this import?',
      message: undoWarning(saved.created),
      confirmLabel: 'Undo import',
      destructive: true,
      onConfirm: () =>
        undo.mutate(saved.importId, {
          onSuccess: setUndone,
          onError: (error) => toast.error(errorMessage(error)),
        }),
    })
  }

  return (
    <div className="space-y-4 rounded-xl border bg-card p-6">
      <p className="text-lg font-semibold">{doneSummary(saved)}</p>
      {undone && <p className="text-sm">{undoneNotice(undone)}</p>}
      <div className="flex flex-wrap gap-2">
        <Link to="/customers?sort=newest" className={cn(buttonVariants({ size: 'lg' }))}>
          View customers
        </Link>
        {!undone && (
          <Button variant="outline" size="lg" disabled={undo.isPending} onClick={askToUndo}>
            {undo.isPending ? 'Undoing…' : 'Undo this import'}
          </Button>
        )}
        <Button variant="ghost" size="lg" onClick={onAnother}>
          Import another file
        </Button>
      </div>
      <ConfirmDialog confirmation={confirmation} onClose={() => setConfirmation(null)} />
    </div>
  )
}
```

- [ ] **Step 3: Put both steps into the page**

In `relay-web/src/routes/customers-import.tsx`, import `CheckStep`, `DoneStep` and `toRows`, then below the Columns step add:

```tsx
      {step === 'check' && picked && checked && (
        <CheckStep
          fileName={picked.fileName}
          grid={picked.sheets[picked.sheet]?.rows ?? []}
          rows={toRows(picked.sheets[picked.sheet]?.rows ?? [], columns)}
          result={checked}
          addressInOneColumn={addressInOneColumn}
          onBack={() => setStep('columns')}
          onSaved={(result) => {
            setSaved(result)
            setStep('done')
          }}
        />
      )}
      {step === 'done' && saved && <DoneStep saved={saved} onAnother={startOver} />}
```

- [ ] **Step 4: Typecheck, tests, build, lint, encoding check, commit**

```bash
npm run typecheck
npx vitest run
npm run build
npx biome check --write src/features/customers/import src/routes/customers-import.tsx
for f in src/features/customers/import/check-step.tsx src/features/customers/import/done-step.tsx src/routes/customers-import.tsx; do head -c3 "$f" | od -c | head -1; grep -c "â€" "$f"; done
git add src/features/customers/import src/routes/customers-import.tsx
git commit -m "feat: check rows and finish or undo a customer import"
```

---

### Task 11: Final verification in both repos

**Files:** none new (fixes only, if the walk-through finds differences).

- [ ] **Step 1: relay-api full check**

```bash
cd relay-api
npm run typecheck
npx vitest run
npx biome check src/modules/customers src/db/schema.ts src/app.ts
```

Expected: clean typecheck, all tests pass, Biome clean.

- [ ] **Step 2: relay-web full check**

```bash
cd relay-web
npm run typecheck
npx vitest run
npm run build
npx biome check src/features/customers src/routes/customers-import.tsx src/routes/customers.tsx src/router.tsx
```

Expected: clean typecheck, all tests pass, build succeeds with the parsers in separate chunks, Biome clean.

- [ ] **Step 3: Headless Edge walk-through**

Use the project's headless Edge method (CDP-driven Edge `--inprivate`, see the controller's brief). Create two sample files outside the repos:
- `sample.csv`: headings `Customer Name,Mobile,E-mail,Address,Brand,Age,Balance`, ~10 rows including one existing customer (same phone and name as a seeded customer), one repeated row, one bad phone, one one-column address that can't be split, one ZIP+4, and one state written out ("Arizona").
- `sample.xlsx` with two sheets (the second named "Old customers"), separate address columns, a phone stored as a number and an install date stored as a date. Generate it with a throwaway script (for example a temporary install of `write-excel-file` in the verify folder); do not add it to the repos.

Screenshot at 1280px and 390px:
- Customers list header with **Import**, and the empty state's **Import a spreadsheet** if reachable
- File step with Past imports, and the errors for a `.pdf` and an empty file
- Columns step for both files (guesses, sample values, "Not imported", switching address mode, switching sheet)
- Check step (counts and filters, problems, Download rows to fix: open the CSV and confirm the Problem column)
- Import, then the Done step, then **View customers** (sorted by Recently added; an imported customer's record says "imported")
- Undo from the Done step, then Undo from Past imports on a second import with one customer given a job first (kept count shows)

Check against the spec's "What the office sees". Fix differences in the smallest way (Write/Edit tools only; JSX typographic quotes as HTML entities), commit each fix in its repo with `fix: …` and no trailer, then re-run Steps 1–2.

- [ ] **Step 4: Report**

Test counts from Steps 1–2, each browser check with its screenshot path, fixes made, dev-database changes, anything skipped. Don't push or merge.
