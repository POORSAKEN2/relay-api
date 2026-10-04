# Contractor Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The superadmin can add a contractor (with a first owner login), see all contractors with their status, and move each between setup, live and turned off; a turned-off contractor is fully off.

**Architecture:** A new `modules/tenants` in relay-api owns the `/api/admin/tenants` routes (list moves there from `modules/branding`). Suspension is enforced in three existing choke points: `tenantFromHost` (public routes), the accounts sign-in functions, and `findSessionWithUser` (every signed-in request). relay-web gets a `features/contractors` folder: data hooks, a pure logic module with tests, and three components used by `routes/admin.tsx`.

**Tech Stack:** relay-api: Node 22, Express 5, Drizzle ORM on Postgres 18, zod 4, vitest + supertest. relay-web: React, Vite, TanStack Query, zod 4, shadcn/ui (Base UI), sonner, vitest (node environment).

**Spec:** `relay-api/docs/superpowers/specs/2026-10-03-contractor-lifecycle-design.md`

## Global Constraints

- Two repositories, side by side: `D:\Sen\personal\HVAC\relay-api` and `D:\Sen\personal\HVAC\relay-web`. Each task names its repo; run commands from that repo's root.
- Work on branch `feat/contractor-lifecycle` in both repos, created from `dev-jan` (Task 1 creates it in relay-api, Task 4 in relay-web).
- relay-web has an untracked `src/features/auth/landing.test.ts` that is not part of this work. Never `git add` it; add files by path.
- API tests need local Postgres with the `relay_test` database (README step 3). `npm test` migrates it in `test/global-setup.ts`.
- No database migration is needed: `tenants.status`, `tenants_slug_unique`, `tenants_slug_format` and `tenants_slug_not_reserved` already exist.
- Every error response is `{ error: { code, message, details? } }`. Validation errors are `400 validation_failed` with `details` keyed by dotted path (`owner.email`).
- Error codes and messages, verbatim:
  - `409 slug_taken`: `That address is taken. Pick another.`
  - `409 email_taken`: `That email already has an account.`
  - `410 contractor_unavailable`: `This contractor is not taking bookings right now`
  - `403 contractor_suspended`: `Your company’s account is turned off. Contact Relay support.`
  - `404 not_found`: `Contractor not found`
- Reserved slugs: `admin`, `api`, `app`, `mail`, `relay`, `www`. Slug format: `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$` after trim + lowercase.
- Temporary password: 12 characters from `abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789`, using `node:crypto` `randomInt`. Never logged, never audited, returned only in the create response.
- Audit actions: `tenant.created` (data `{ slug, ownerUserId }`) and `tenant.status_changed` (data `{ from, to }`), entity type `tenant`, `tenantId` = the contractor.
- Code style: Biome (`npm run lint`), 2-space indent, single quotes, no semicolons, comments only where they explain why. Curly apostrophes (`’`) in user-facing text, as the codebase does.
- Before each commit, in the task's repo: `npm run typecheck` and `npm run lint` pass.
- End every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Owner email typed with capitals or spaces (`  Casey@CoolBreeze.test `): stored lowercased and trimmed, and the owner can sign in with it. Pinned in Task 1.
2. Slug typed with capitals (`CoolBreeze`) when `coolbreeze` exists: normalized and answered `409 slug_taken`, not a second contractor. Pinned in Task 1.
3. Suspending one contractor must not sign out another contractor's staff or the superadmin doing it. Pinned in Task 2.
4. A wrong password for a turned-off contractor's user still gets the plain `401`, so the answer doesn't confirm the account exists. Pinned in Task 3.
5. A session opened before suspension, where the sessions were not deleted (the race the spec mentions), is still refused. Pinned in Task 3 by suspending with a direct DB update.

---

### Task 1: API – contractor list and create (`modules/tenants`)

Repo: relay-api.

**Files:**
- Create: `src/modules/tenants/tenants.schemas.ts`
- Create: `src/modules/tenants/tenants.queries.ts`
- Create: `src/modules/tenants/tenants.service.ts`
- Create: `src/modules/tenants/tenants.routes.ts`
- Create: `src/modules/tenants/tenants.test.ts`
- Modify: `src/app.ts` (import and mount `tenantsRoutes`)
- Modify: `src/modules/branding/branding.routes.ts` (remove `GET /admin/tenants`)
- Modify: `src/modules/branding/branding.service.ts` (remove `listTenants`)
- Modify: `src/modules/branding/branding.queries.ts` (remove `listTenants` and the now-unused `asc` import)
- Modify: `src/modules/branding/branding.test.ts` (remove the `describe('GET /api/admin/tenants')` block; it moves to the tenants test)

**Interfaces:**
- Consumes: `hashPassword(password: string): Promise<string>` from `src/modules/accounts/passwords.ts`; `audit.insertUserAction(tenantId, event, tx)` from `src/modules/audit/audit.queries.ts`; `violatedUniqueConstraint(error)` from `src/lib/db-errors.ts`; `TenantParams` from `src/modules/branding/branding.schemas.ts`; `SessionUser` from `src/modules/accounts/accounts.service.ts`.
- Produces:
  - `tenants.schemas.ts`: `RESERVED_SLUGS: string[]`, `CreateTenantInput` (zod) + type, `TenantStatus = 'setup' | 'live' | 'suspended'`.
  - `tenants.queries.ts`: `tenantColumns`, `listTenants()`, `insertTenant(values, tx)`, `insertOwner(values, tx)`.
  - `tenants.service.ts`: `generateTemporaryPassword(): string`, `listTenants()`, `createTenant(admin: SessionUser, input: CreateTenantInput): Promise<{ tenant: TenantSummary; owner: { id: string; name: string; email: string | null; temporaryPassword: string } }>`.
  - `tenants.routes.ts`: `tenantsRoutes` (Express Router).
  - JSON list item (`TenantSummary`): `{ id, slug, name, status, contactEmail, contactPhone, createdAt }`.

- [ ] **Step 1: Create the branch**

```bash
git checkout dev-jan
git checkout -b feat/contractor-lifecycle
```

- [ ] **Step 2: Write the failing tests**

Create `src/modules/tenants/tenants.test.ts`:

```ts
import { eq } from 'drizzle-orm'
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'
import { createTenant, createUser, resetDb, signIn } from '../../../test/helpers.ts'
import { createApp } from '../../app.ts'
import { db } from '../../db/client.ts'
import { auditEvents, tenants } from '../../db/schema.ts'
import * as accounts from '../accounts/accounts.service.ts'
import { generateTemporaryPassword } from './tenants.service.ts'

const app = createApp()

beforeEach(resetDb)

async function signedInAdmin() {
  const admin = await createUser('superadmin', null)
  return { admin, cookie: await signIn(admin.email) }
}

function newContractor() {
  return {
    name: 'Cool Breeze HVAC',
    slug: 'coolbreeze',
    timezone: 'America/Denver',
    contactEmail: 'Office@CoolBreeze.test',
    contactPhone: '(303) 555-0142',
    owner: { name: 'Casey Owner', email: '  Casey@CoolBreeze.test ' },
  }
}

describe('GET /api/admin/tenants', () => {
  it('lists contractors by name with their status and contact details', async () => {
    await createTenant('other')
    await createTenant('desert')
    const { cookie } = await signedInAdmin()

    const res = await request(app).get('/api/admin/tenants').set('Cookie', cookie).expect(200)

    expect(res.body.tenants.map((t: { slug: string }) => t.slug)).toEqual(['desert', 'other'])
    expect(res.body.tenants[0]).toEqual({
      id: expect.any(String),
      slug: 'desert',
      name: 'desert HVAC',
      status: 'setup',
      contactEmail: 'office@desert.test',
      contactPhone: '+14805550100',
      createdAt: expect.any(String),
    })
  })

  it('needs a signed-in superadmin', async () => {
    const desert = await createTenant('desert')
    const owner = await createUser('owner', desert.id)

    await request(app).get('/api/admin/tenants').expect(401)
    await request(app)
      .get('/api/admin/tenants')
      .set('Cookie', await signIn(owner.email))
      .expect(403)
  })
})

describe('POST /api/admin/tenants', () => {
  it('creates a contractor in setup and an owner who can sign in right away', async () => {
    const { cookie } = await signedInAdmin()

    const res = await request(app)
      .post('/api/admin/tenants')
      .set('Cookie', cookie)
      .send(newContractor())
      .expect(201)

    expect(res.body.tenant).toMatchObject({
      slug: 'coolbreeze',
      name: 'Cool Breeze HVAC',
      status: 'setup',
      contactEmail: 'office@coolbreeze.test',
      contactPhone: '+13035550142',
    })
    expect(res.body.owner).toMatchObject({ name: 'Casey Owner', email: 'casey@coolbreeze.test' })
    const session = await accounts.signIn('casey@coolbreeze.test', res.body.owner.temporaryPassword)
    expect(session.user).toMatchObject({ role: 'owner', tenantId: res.body.tenant.id })
  })

  it('records who created it, without the password', async () => {
    const { admin, cookie } = await signedInAdmin()

    const res = await request(app)
      .post('/api/admin/tenants')
      .set('Cookie', cookie)
      .send(newContractor())
      .expect(201)

    const events = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.tenantId, res.body.tenant.id))
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      actorType: 'user',
      actorUserId: admin.id,
      action: 'tenant.created',
      entityType: 'tenant',
      entityId: res.body.tenant.id,
      data: { slug: 'coolbreeze', ownerUserId: res.body.owner.id },
    })
    expect(JSON.stringify(events)).not.toContain(res.body.owner.temporaryPassword)
  })

  it('answers 409 slug_taken for a taken address, whatever its capitals', async () => {
    await createTenant('coolbreeze')
    const { cookie } = await signedInAdmin()

    const res = await request(app)
      .post('/api/admin/tenants')
      .set('Cookie', cookie)
      .send({ ...newContractor(), slug: 'CoolBreeze' })
      .expect(409)

    expect(res.body.error).toEqual({
      code: 'slug_taken',
      message: 'That address is taken. Pick another.',
    })
  })

  it('answers 409 email_taken and leaves no contractor behind', async () => {
    const desert = await createTenant('desert')
    const existing = await createUser('owner', desert.id)
    const { cookie } = await signedInAdmin()

    const res = await request(app)
      .post('/api/admin/tenants')
      .set('Cookie', cookie)
      .send({ ...newContractor(), owner: { name: 'Casey Owner', email: existing.email } })
      .expect(409)

    expect(res.body.error.code).toBe('email_taken')
    const left = await db.select().from(tenants).where(eq(tenants.slug, 'coolbreeze'))
    expect(left).toEqual([])
  })

  it.each([
    ['a reserved address', { slug: 'app' }, 'slug'],
    ['an address ending in a dash', { slug: 'cool-' }, 'slug'],
    ['an unknown time zone', { timezone: 'Mars/Base' }, 'timezone'],
    ['a bad phone number', { contactPhone: '555' }, 'contactPhone'],
    ['a missing owner email', { owner: { name: 'Casey Owner', email: '' } }, 'owner.email'],
  ])('rejects %s with a field error', async (_label, change, field) => {
    const { cookie } = await signedInAdmin()

    const res = await request(app)
      .post('/api/admin/tenants')
      .set('Cookie', cookie)
      .send({ ...newContractor(), ...change })
      .expect(400)

    expect(res.body.error.code).toBe('validation_failed')
    expect(Object.keys(res.body.error.details)).toEqual([field])
  })

  it('needs a signed-in superadmin', async () => {
    const desert = await createTenant('desert')
    const owner = await createUser('owner', desert.id)

    await request(app).post('/api/admin/tenants').send(newContractor()).expect(401)
    await request(app)
      .post('/api/admin/tenants')
      .set('Cookie', await signIn(owner.email))
      .send(newContractor())
      .expect(403)
  })
})

describe('generateTemporaryPassword', () => {
  it('makes 12 characters without look-alikes, different each time', () => {
    const passwords = Array.from({ length: 50 }, generateTemporaryPassword)
    for (const password of passwords) {
      expect(password).toMatch(/^[a-km-zA-HJ-NP-Z2-9]{12}$/)
    }
    expect(new Set(passwords).size).toBe(50)
  })
})
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `npm test -- src/modules/tenants/tenants.test.ts`
Expected: FAIL. The import of `./tenants.service.ts` fails because the file doesn't exist yet.

- [ ] **Step 4: Write the schemas**

Create `src/modules/tenants/tenants.schemas.ts`:

```ts
import { z } from 'zod'
import { TENANT_STATUSES } from '../../db/schema.ts'
import { UsPhone } from '../../lib/fields.ts'

export type TenantStatus = (typeof TENANT_STATUSES)[number]

// Hostnames Relay uses or will use. The database refuses admin, api and www too; checking
// here turns them into a field error instead of a 500.
export const RESERVED_SLUGS = ['admin', 'api', 'app', 'mail', 'relay', 'www']

const TIMEZONES = new Set(Intl.supportedValuesOf('timeZone'))

// Trimmed and lowercased before the format check, so ' Casey@X.test ' is accepted.
const Email = z.string().trim().toLowerCase().pipe(z.email('Enter a valid email address'))

export const CreateTenantInput = z.object({
  name: z.string().trim().min(1, 'Enter the company name').max(100),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(
      /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/,
      'Use lowercase letters, numbers and dashes, not at the start or end',
    )
    .refine((slug) => !RESERVED_SLUGS.includes(slug), 'That address is reserved. Pick another.'),
  timezone: z.string().refine((zone) => TIMEZONES.has(zone), 'Pick a time zone'),
  contactEmail: Email,
  contactPhone: UsPhone,
  owner: z.object({
    name: z.string().trim().min(1, 'Enter the owner’s name').max(100),
    email: Email,
  }),
})
export type CreateTenantInput = z.infer<typeof CreateTenantInput>
```

- [ ] **Step 5: Write the queries**

Create `src/modules/tenants/tenants.queries.ts`:

```ts
import { asc } from 'drizzle-orm'
import { type Db, db } from '../../db/client.ts'
import { tenants, users } from '../../db/schema.ts'

// Platform-level: the superadmin manages every contractor, so these are not tenant-scoped.

// What the admin page shows for each contractor.
export const tenantColumns = {
  id: tenants.id,
  slug: tenants.slug,
  name: tenants.name,
  status: tenants.status,
  contactEmail: tenants.contactEmail,
  contactPhone: tenants.contactPhone,
  createdAt: tenants.createdAt,
}

export function listTenants() {
  return db.select(tenantColumns).from(tenants).orderBy(asc(tenants.name))
}

export async function insertTenant(
  values: Pick<
    typeof tenants.$inferInsert,
    'name' | 'slug' | 'timezone' | 'contactEmail' | 'contactPhone'
  >,
  tx: Db,
) {
  const [tenant] = await tx.insert(tenants).values(values).returning(tenantColumns)
  return tenant
}

export async function insertOwner(
  values: { tenantId: string; name: string; email: string; passwordHash: string },
  tx: Db,
) {
  const [owner] = await tx
    .insert(users)
    .values({ ...values, role: 'owner' })
    .returning({ id: users.id, name: users.name, email: users.email })
  return owner
}
```

- [ ] **Step 6: Write the service**

Create `src/modules/tenants/tenants.service.ts`:

```ts
import { randomInt } from 'node:crypto'
import { db } from '../../db/client.ts'
import { violatedUniqueConstraint } from '../../lib/db-errors.ts'
import { HttpError } from '../../lib/http-error.ts'
import type { SessionUser } from '../accounts/accounts.service.ts'
import { hashPassword } from '../accounts/passwords.ts'
import * as audit from '../audit/audit.queries.ts'
import * as queries from './tenants.queries.ts'
import type { CreateTenantInput } from './tenants.schemas.ts'

// The superadmin adds contractors and turns them on and off. Contractors are never deleted.

// No 0/O or 1/l/I: the admin may read it out or retype it.
const PASSWORD_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const PASSWORD_LENGTH = 12

export function generateTemporaryPassword(): string {
  return Array.from(
    { length: PASSWORD_LENGTH },
    () => PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)],
  ).join('')
}

export function listTenants() {
  return queries.listTenants()
}

// Adds a contractor in `setup` with its first owner. The owner's temporary password is
// returned here only: it's stored hashed and never logged.
export async function createTenant(admin: SessionUser, input: CreateTenantInput) {
  const { owner: ownerInput, ...tenantInput } = input
  const temporaryPassword = generateTemporaryPassword()
  const passwordHash = await hashPassword(temporaryPassword)
  try {
    return await db.transaction(async (tx) => {
      const tenant = await queries.insertTenant(tenantInput, tx)
      const owner = await queries.insertOwner(
        { tenantId: tenant.id, ...ownerInput, passwordHash },
        tx,
      )
      await audit.insertUserAction(
        tenant.id,
        {
          actorUserId: admin.id,
          action: 'tenant.created',
          entityType: 'tenant',
          entityId: tenant.id,
          data: { slug: tenant.slug, ownerUserId: owner.id },
        },
        tx,
      )
      return { tenant, owner: { ...owner, temporaryPassword } }
    })
  } catch (error) {
    const constraint = violatedUniqueConstraint(error)
    if (constraint === 'tenants_slug_unique') {
      throw new HttpError(409, 'slug_taken', 'That address is taken. Pick another.')
    }
    if (constraint === 'users_email_unique') {
      throw new HttpError(409, 'email_taken', 'That email already has an account.')
    }
    throw error
  }
}
```

- [ ] **Step 7: Write the routes and mount them**

Create `src/modules/tenants/tenants.routes.ts`:

```ts
import { Router } from 'express'
import { requireRole } from '../../middleware/auth.ts'
import { CreateTenantInput } from './tenants.schemas.ts'
import * as tenants from './tenants.service.ts'

export const tenantsRoutes = Router()

const superadmin = requireRole('superadmin')

tenantsRoutes.get('/admin/tenants', superadmin, async (_req, res) => {
  res.json({ tenants: await tenants.listTenants() })
})

tenantsRoutes.post('/admin/tenants', superadmin, async (req, res) => {
  const input = CreateTenantInput.parse(req.body)
  res.status(201).json(await tenants.createTenant(req.user!, input))
})
```

In `src/app.ts`, add the import after the `technicianJobsRoutes` import:

```ts
import { tenantsRoutes } from './modules/tenants/tenants.routes.ts'
```

and add `tenantsRoutes,` to the `app.use('/api', …)` list after `technicianJobsRoutes,`.

- [ ] **Step 8: Remove the old list from branding**

In `src/modules/branding/branding.routes.ts`, delete:

```ts
brandingRoutes.get('/admin/tenants', requireRole('superadmin'), async (_req, res) => {
  res.json({ tenants: await branding.listTenants() })
})
```

In `src/modules/branding/branding.service.ts`, delete:

```ts
export function listTenants() {
  return queries.listTenants()
}
```

In `src/modules/branding/branding.queries.ts`, delete the `listTenants` function and change the first import to `import { desc, eq } from 'drizzle-orm'`.

In `src/modules/branding/branding.test.ts`, delete the whole `describe('GET /api/admin/tenants', …)` block at the end of the file.

- [ ] **Step 9: Run the tests to see them pass**

Run: `npm test -- src/modules/tenants src/modules/branding`
Expected: PASS, all tests.

- [ ] **Step 10: Check and commit**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all pass.

```bash
git add src/modules/tenants src/app.ts src/modules/branding/branding.routes.ts src/modules/branding/branding.service.ts src/modules/branding/branding.queries.ts src/modules/branding/branding.test.ts
git commit -m "feat: let the superadmin add contractors with a first owner

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: API – change a contractor's status

Repo: relay-api.

**Files:**
- Modify: `src/modules/tenants/tenants.schemas.ts` (add `TenantStatusInput`)
- Modify: `src/modules/tenants/tenants.queries.ts` (add `findTenantStatusForUpdate`, `updateTenantStatus`, `deleteTenantSessions`)
- Modify: `src/modules/tenants/tenants.service.ts` (add `setTenantStatus`)
- Modify: `src/modules/tenants/tenants.routes.ts` (add `PATCH /admin/tenants/:tenantId/status`)
- Test: `src/modules/tenants/tenants.test.ts`

**Interfaces:**
- Consumes: Task 1's `tenantColumns`, `TenantStatus`, `tenantsRoutes`; `TenantParams` (`{ tenantId: uuid }`) from `src/modules/branding/branding.schemas.ts`.
- Produces: `setTenantStatus(admin: SessionUser, tenantId: string, status: TenantStatus): Promise<TenantSummary>`; route answers `{ tenant: TenantSummary }`.

- [ ] **Step 1: Write the failing tests**

In `src/modules/tenants/tenants.test.ts`, change the drizzle and schema imports to:

```ts
import { and, eq } from 'drizzle-orm'
```

```ts
import { auditEvents, sessions, tenants, users } from '../../db/schema.ts'
```

and append:

```ts
describe('PATCH /api/admin/tenants/:tenantId/status', () => {
  async function sessionCount(tenantId: string) {
    const rows = await db
      .select({ id: sessions.id })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(eq(users.tenantId, tenantId))
    return rows.length
  }

  async function statusEvents(tenantId: string) {
    return db
      .select({ data: auditEvents.data })
      .from(auditEvents)
      .where(
        and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.action, 'tenant.status_changed')),
      )
  }

  it('moves a contractor between statuses and records each change', async () => {
    const desert = await createTenant('desert')
    const { cookie } = await signedInAdmin()
    const url = `/api/admin/tenants/${desert.id}/status`

    const live = await request(app)
      .patch(url)
      .set('Cookie', cookie)
      .send({ status: 'live' })
      .expect(200)
    expect(live.body.tenant).toMatchObject({ id: desert.id, status: 'live' })

    await request(app).patch(url).set('Cookie', cookie).send({ status: 'suspended' }).expect(200)
    await request(app).patch(url).set('Cookie', cookie).send({ status: 'live' }).expect(200)

    expect((await statusEvents(desert.id)).map((e) => e.data)).toEqual([
      { from: 'setup', to: 'live' },
      { from: 'live', to: 'suspended' },
      { from: 'suspended', to: 'live' },
    ])
  })

  it('signs out everyone at a suspended contractor, and nobody else', async () => {
    const desert = await createTenant('desert')
    const other = await createTenant('other')
    const desertOwner = await createUser('owner', desert.id)
    const desertOffice = await createUser('office', desert.id)
    const otherOwner = await createUser('owner', other.id)
    await signIn(desertOwner.email)
    await signIn(desertOffice.email)
    await signIn(otherOwner.email)
    const { cookie } = await signedInAdmin()

    await request(app)
      .patch(`/api/admin/tenants/${desert.id}/status`)
      .set('Cookie', cookie)
      .send({ status: 'suspended' })
      .expect(200)

    expect(await sessionCount(desert.id)).toBe(0)
    expect(await sessionCount(other.id)).toBe(1)
    await request(app).get('/api/admin/tenants').set('Cookie', cookie).expect(200)
  })

  it('records nothing when the status is already set', async () => {
    const desert = await createTenant('desert')
    const { cookie } = await signedInAdmin()
    const url = `/api/admin/tenants/${desert.id}/status`

    await request(app).patch(url).set('Cookie', cookie).send({ status: 'live' }).expect(200)
    await request(app).patch(url).set('Cookie', cookie).send({ status: 'live' }).expect(200)

    expect(await statusEvents(desert.id)).toHaveLength(1)
  })

  it('404s for an unknown contractor and rejects an unknown status', async () => {
    const desert = await createTenant('desert')
    const { cookie } = await signedInAdmin()

    await request(app)
      .patch('/api/admin/tenants/00000000-0000-4000-8000-000000000000/status')
      .set('Cookie', cookie)
      .send({ status: 'live' })
      .expect(404)
    const bad = await request(app)
      .patch(`/api/admin/tenants/${desert.id}/status`)
      .set('Cookie', cookie)
      .send({ status: 'deleted' })
      .expect(400)
    expect(Object.keys(bad.body.error.details)).toEqual(['status'])
  })

  it('needs a signed-in superadmin', async () => {
    const desert = await createTenant('desert')
    const owner = await createUser('owner', desert.id)

    await request(app)
      .patch(`/api/admin/tenants/${desert.id}/status`)
      .set('Cookie', await signIn(owner.email))
      .send({ status: 'suspended' })
      .expect(403)
  })
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npm test -- src/modules/tenants/tenants.test.ts`
Expected: FAIL. The new tests get `404 Route not found` for the PATCH.

- [ ] **Step 3: Add the input schema**

Append to `src/modules/tenants/tenants.schemas.ts`:

```ts
export const TenantStatusInput = z.object({
  status: z.enum(TENANT_STATUSES, 'Pick setup, live or suspended'),
})
```

- [ ] **Step 4: Add the queries**

In `src/modules/tenants/tenants.queries.ts`, change the imports to:

```ts
import { asc, eq, inArray } from 'drizzle-orm'
import { type Db, db } from '../../db/client.ts'
import { sessions, tenants, users } from '../../db/schema.ts'
import type { TenantStatus } from './tenants.schemas.ts'
```

and append:

```ts
// Locks the row so two status changes at once are recorded in order.
export async function findTenantStatusForUpdate(tenantId: string, tx: Db) {
  const [tenant] = await tx
    .select({ status: tenants.status })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .for('update')
  return tenant
}

export async function updateTenantStatus(tenantId: string, status: TenantStatus, tx: Db) {
  const [tenant] = await tx
    .update(tenants)
    .set({ status })
    .where(eq(tenants.id, tenantId))
    .returning(tenantColumns)
  return tenant
}

// Signs out everyone at one contractor.
export async function deleteTenantSessions(tenantId: string, tx: Db) {
  await tx
    .delete(sessions)
    .where(
      inArray(
        sessions.userId,
        tx.select({ id: users.id }).from(users).where(eq(users.tenantId, tenantId)),
      ),
    )
}
```

- [ ] **Step 5: Add the service function**

In `src/modules/tenants/tenants.service.ts`, change the schemas import to:

```ts
import type { CreateTenantInput, TenantStatus } from './tenants.schemas.ts'
```

and append:

```ts
// Turning a contractor off signs its people out at once. Sessions and sign-in also check
// the status (modules/accounts), so a sign-in racing this can't slip through.
export async function setTenantStatus(admin: SessionUser, tenantId: string, status: TenantStatus) {
  return db.transaction(async (tx) => {
    const current = await queries.findTenantStatusForUpdate(tenantId, tx)
    if (!current) throw new HttpError(404, 'not_found', 'Contractor not found')
    const tenant = await queries.updateTenantStatus(tenantId, status, tx)
    if (status === 'suspended') await queries.deleteTenantSessions(tenantId, tx)
    if (current.status !== status) {
      await audit.insertUserAction(
        tenantId,
        {
          actorUserId: admin.id,
          action: 'tenant.status_changed',
          entityType: 'tenant',
          entityId: tenantId,
          data: { from: current.status, to: status },
        },
        tx,
      )
    }
    return tenant
  })
}
```

- [ ] **Step 6: Add the route**

In `src/modules/tenants/tenants.routes.ts`, change the imports to:

```ts
import { Router } from 'express'
import { requireRole } from '../../middleware/auth.ts'
import { TenantParams } from '../branding/branding.schemas.ts'
import { CreateTenantInput, TenantStatusInput } from './tenants.schemas.ts'
import * as tenants from './tenants.service.ts'
```

and append:

```ts
tenantsRoutes.patch('/admin/tenants/:tenantId/status', superadmin, async (req, res) => {
  const { tenantId } = TenantParams.parse(req.params)
  const { status } = TenantStatusInput.parse(req.body)
  res.json({ tenant: await tenants.setTenantStatus(req.user!, tenantId, status) })
})
```

- [ ] **Step 7: Run the tests to see them pass**

Run: `npm test -- src/modules/tenants/tenants.test.ts`
Expected: PASS.

- [ ] **Step 8: Check and commit**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all pass.

```bash
git add src/modules/tenants
git commit -m "feat: let the superadmin take a contractor live or turn it off

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: API – a turned-off contractor is fully off

Repo: relay-api.

**Files:**
- Modify: `src/middleware/tenant.ts` (`tenantFromHost` refuses suspended contractors)
- Modify: `src/modules/accounts/accounts.queries.ts` (`findSessionWithUser`, `findTechnicianByPhone`, new `findTenantStatus`)
- Modify: `src/modules/accounts/accounts.service.ts` (`signIn`, `requestSignInCode`, `signInWithCode`)
- Modify: `src/modules/branding/branding.test.ts` (410 test)
- Create: `src/modules/accounts/suspended.test.ts`

**Interfaces:**
- Consumes: nothing from Tasks 1–2 at runtime. Tests suspend contractors with a direct DB update so they don't depend on the PATCH route, and that also covers sessions that weren't deleted.
- Produces: `410 contractor_unavailable` from every `tenantFromHost` route; `403 contractor_suspended` from sign-in; sessions of suspended contractors' users are treated as signed out.

- [ ] **Step 1: Write the failing tests**

Append to the `describe('GET /api/branding', …)` block in `src/modules/branding/branding.test.ts`, and add `tenants` to its schema import (`import { brandingVersions, tenants } from '../../db/schema.ts'`):

```ts
  it('answers 410 for a turned-off contractor', async () => {
    const desert = await createTenant('desert')
    await db.update(tenants).set({ status: 'suspended' }).where(eq(tenants.id, desert.id))

    const res = await request(app)
      .get('/api/branding')
      .set('X-Tenant-Host', 'desert.localhost')
      .expect(410)
    expect(res.body.error).toEqual({
      code: 'contractor_unavailable',
      message: 'This contractor is not taking bookings right now',
    })
  })
```

Create `src/modules/accounts/suspended.test.ts`:

```ts
import { count, eq } from 'drizzle-orm'
import request from 'supertest'
import { beforeEach, expect, it } from 'vitest'
import { createTenant, createUser, PASSWORD, resetDb, signIn } from '../../../test/helpers.ts'
import { createApp } from '../../app.ts'
import { db } from '../../db/client.ts'
import { signInCodes, tenants } from '../../db/schema.ts'
import * as accounts from './accounts.service.ts'

// The sign-in routes are rate limited, so these call the service directly; the session
// checks go through the app.

const app = createApp()

beforeEach(resetDb)

// A direct update, without the admin route: proves the checks hold even if sessions were
// not deleted.
async function setStatus(tenantId: string, status: 'live' | 'suspended') {
  await db.update(tenants).set({ status }).where(eq(tenants.id, tenantId))
}

const suspendedError = {
  status: 403,
  code: 'contractor_suspended',
  message: 'Your company’s account is turned off. Contact Relay support.',
}

it('refuses email sign-in at a turned-off contractor, but only after the password', async () => {
  const desert = await createTenant('desert')
  const owner = await createUser('owner', desert.id)
  await setStatus(desert.id, 'suspended')

  await expect(accounts.signIn(owner.email, PASSWORD)).rejects.toMatchObject(suspendedError)
  await expect(accounts.signIn(owner.email, 'wrong password')).rejects.toMatchObject({
    status: 401,
    code: 'unauthorized',
  })
})

it('texts no sign-in code to a technician of a turned-off contractor', async () => {
  const desert = await createTenant('desert')
  const technician = await createUser('technician', desert.id)
  await setStatus(desert.id, 'suspended')

  await accounts.requestSignInCode(technician.phone!)

  const [{ codes }] = await db
    .select({ codes: count() })
    .from(signInCodes)
    .where(eq(signInCodes.userId, technician.id))
  expect(codes).toBe(0)
})

it('refuses a code sent before the contractor was turned off', async () => {
  const desert = await createTenant('desert')
  const technician = await createUser('technician', desert.id)
  await db.insert(signInCodes).values({
    userId: technician.id,
    codeHash: accounts.hashCode('123456'),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  })
  await setStatus(desert.id, 'suspended')

  await expect(accounts.signInWithCode(technician.phone!, '123456')).rejects.toMatchObject(
    suspendedError,
  )
})

it('treats sessions opened before the contractor was turned off as signed out', async () => {
  const desert = await createTenant('desert')
  const office = await createUser('office', desert.id)
  const cookie = await signIn(office.email)
  await setStatus(desert.id, 'suspended')

  const me = await request(app).get('/api/auth/me').set('Cookie', cookie).expect(200)
  expect(me.body.user).toBeNull()
  await request(app).get('/api/technicians').set('Cookie', cookie).expect(401)
})

it('lets everyone back in when the contractor is turned on again', async () => {
  const desert = await createTenant('desert')
  const owner = await createUser('owner', desert.id)
  await setStatus(desert.id, 'suspended')
  await setStatus(desert.id, 'live')

  const cookie = await signIn(owner.email)
  const me = await request(app).get('/api/auth/me').set('Cookie', cookie).expect(200)
  expect(me.body.user).toMatchObject({ id: owner.id })
})

it('never affects the superadmin', async () => {
  const desert = await createTenant('desert')
  const admin = await createUser('superadmin', null)
  const cookie = await signIn(admin.email)
  await setStatus(desert.id, 'suspended')

  const me = await request(app).get('/api/auth/me').set('Cookie', cookie).expect(200)
  expect(me.body.user).toMatchObject({ id: admin.id, role: 'superadmin' })
  await expect(accounts.signIn(admin.email, PASSWORD)).resolves.toBeTruthy()
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npm test -- src/modules/accounts/suspended.test.ts src/modules/branding/branding.test.ts`
Expected: FAIL. The 410 test gets 200; sign-in resolves instead of rejecting; `/api/auth/me` returns the user; a code is created.

- [ ] **Step 3: Refuse turned-off contractors on public routes**

In `src/middleware/tenant.ts`, replace the body of `tenantFromHost` with:

```ts
export const tenantFromHost: RequestHandler = async (req, _res, next) => {
  const host = parseTenantHost(req.get('x-tenant-host') ?? '', env.APP_DOMAIN)
  const tenant = host ? await findTenantByHost(host) : undefined
  if (!tenant) throw new HttpError(404, 'not_found', 'Contractor not found')
  if (tenant.status === 'suspended') {
    throw new HttpError(
      410,
      'contractor_unavailable',
      'This contractor is not taking bookings right now',
    )
  }
  req.tenant = tenant
  next()
}
```

- [ ] **Step 4: Make the account queries aware of the status**

In `src/modules/accounts/accounts.queries.ts`, change the first import to:

```ts
import { and, count, desc, eq, gt, isNull, lt, ne, or, sql } from 'drizzle-orm'
```

Replace `findSessionWithUser` with:

```ts
export async function findSessionWithUser(id: string) {
  const [row] = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .leftJoin(tenants, eq(users.tenantId, tenants.id))
    // Deactivating a user or turning off a contractor deletes sessions, but a sign-in racing
    // it could insert one afterwards. Checking here makes both hold whatever the order.
    // The superadmin has no contractor.
    .where(
      and(
        eq(sessions.id, id),
        isNull(users.disabledAt),
        or(isNull(users.tenantId), ne(tenants.status, 'suspended')),
      ),
    )
    .limit(1)
  return row
}
```

Replace `findTechnicianByPhone` with:

```ts
// An active technician with this phone, and their contractor for the sign-in text.
export async function findTechnicianByPhone(phone: string) {
  const [row] = await db
    .select({
      user: users,
      tenantId: tenants.id,
      tenantName: tenants.name,
      tenantStatus: tenants.status,
    })
    .from(users)
    .innerJoin(tenants, eq(users.tenantId, tenants.id))
    .where(and(eq(users.phone, phone), eq(users.role, 'technician'), isNull(users.disabledAt)))
    .limit(1)
  return row
}
```

Add after `findUserByEmail`:

```ts
export async function findTenantStatus(tenantId: string) {
  const [tenant] = await db
    .select({ status: tenants.status })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1)
  return tenant?.status
}
```

- [ ] **Step 5: Refuse sign-in at turned-off contractors**

In `src/modules/accounts/accounts.service.ts`:

Replace `signIn` with:

```ts
export async function signIn(email: string, password: string) {
  const user = await queries.findUserByEmail(email)
  // Check a password even for an unknown email, so both failures take the same time.
  const passwordOk = await verifyPassword(password, user?.passwordHash ?? (await dummyHash()))
  if (!user?.passwordHash || !passwordOk) {
    throw new HttpError(401, 'unauthorized', 'Wrong email or password')
  }
  // Only after the password, so this answer doesn't reveal which emails have accounts.
  if (user.tenantId && (await queries.findTenantStatus(user.tenantId)) === 'suspended') {
    throw contractorSuspended()
  }
  return startSession(user)
}
```

In `requestSignInCode`, change the first two lines to:

```ts
  const found = await queries.findTechnicianByPhone(phone)
  if (!found || found.tenantStatus === 'suspended') return
```

In `signInWithCode`, replace the last line `return startSession(found.user)` with:

```ts
  if (found.tenantStatus === 'suspended') throw contractorSuspended()
  return startSession(found.user)
```

Add after `wrongCode`:

```ts
function contractorSuspended() {
  return new HttpError(
    403,
    'contractor_suspended',
    'Your company’s account is turned off. Contact Relay support.',
  )
}
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `npm test -- src/modules/accounts src/modules/branding src/middleware`
Expected: PASS.

- [ ] **Step 7: Check and commit**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all pass.

```bash
git add src/middleware/tenant.ts src/modules/accounts/accounts.queries.ts src/modules/accounts/accounts.service.ts src/modules/accounts/suspended.test.ts src/modules/branding/branding.test.ts
git commit -m "feat: close the booking page and sign-in of a turned-off contractor

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Web – contractor data hooks and admin page logic

Repo: relay-web.

**Files:**
- Create: `src/features/contractors/api.ts`
- Create: `src/features/contractors/contractors.ts`
- Create: `src/features/contractors/contractors.test.ts`
- Modify: `src/features/branding/api.ts` (remove `TenantList` and `useTenants`; they move to contractors)

**Interfaces:**
- Consumes: API from Tasks 1–2: `GET /api/admin/tenants` → `{ tenants: Tenant[] }`, `POST /api/admin/tenants` → `201 { tenant, owner: { id, name, email, temporaryPassword } }`, `PATCH /api/admin/tenants/:id/status` → `{ tenant }`. `api.get/post/patch(path, body?, schema)` and `ApiError` (`status`, `code`, `message`, `details: Record<string, string[]>`) from `@/lib/api`. `FieldErrors` type from `@/components/form-field`.
- Produces:
  - `api.ts`: `TenantStatus`, `Tenant`, `CreatedTenant`, `CreateTenantInput`, `useTenants()`, `useCreateTenant()`, `useSetTenantStatus()` (mutate with `{ tenantId, status }`).
  - `contractors.ts`: `STATUS_LABELS`, `statusAction(status) → { label, to, confirm }`, `statusChangedNotice(name, status)`, `TURN_OFF_MESSAGE`, `filterContractors(list, query)`, `createErrorFields(error) → FieldErrors | null`, `US_TIMEZONES`, `timezoneOptions(all?)`, `defaultTimezone()`.

- [ ] **Step 1: Create the branch**

```bash
git checkout dev-jan
git checkout -b feat/contractor-lifecycle
```

The untracked `src/features/auth/landing.test.ts` comes along untouched; leave it alone.

- [ ] **Step 2: Write the failing tests**

Create `src/features/contractors/contractors.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { ApiError } from '@/lib/api'
import {
  createErrorFields,
  filterContractors,
  statusAction,
  statusChangedNotice,
  timezoneOptions,
  US_TIMEZONES,
} from './contractors'

function apiError(status: number, code: string, message: string, details = {}) {
  return new ApiError(status, { code, message, details })
}

describe('statusAction', () => {
  it.each([
    ['setup', { label: 'Go live', to: 'live', confirm: false }],
    ['live', { label: 'Turn off', to: 'suspended', confirm: true }],
    ['suspended', { label: 'Turn on', to: 'live', confirm: false }],
  ] as const)('%s', (status, expected) => {
    expect(statusAction(status)).toEqual(expected)
  })
})

describe('statusChangedNotice', () => {
  it.each([
    ['live', 'Desert Breeze Air is live.'],
    ['suspended', 'Desert Breeze Air is turned off.'],
    ['setup', 'Desert Breeze Air is back in setup.'],
  ] as const)('%s', (status, expected) => {
    expect(statusChangedNotice('Desert Breeze Air', status)).toBe(expected)
  })
})

describe('filterContractors', () => {
  const list = [
    { name: 'Desert Breeze Air', slug: 'desert' },
    { name: 'Cool Breeze HVAC', slug: 'coolbreeze' },
    { name: 'Polar Heating', slug: 'polar' },
  ]

  it('matches the name or the address, ignoring case and spaces around', () => {
    expect(filterContractors(list, '  BREEZE ').map((t) => t.slug)).toEqual([
      'desert',
      'coolbreeze',
    ])
    expect(filterContractors(list, 'pol').map((t) => t.slug)).toEqual(['polar'])
  })

  it('shows everyone for an empty search', () => {
    expect(filterContractors(list, '   ')).toEqual(list)
  })
})

describe('createErrorFields', () => {
  it('keeps validation details as they are', () => {
    const details = { 'owner.email': ['Enter a valid email address'] }
    expect(
      createErrorFields(apiError(400, 'validation_failed', 'Check the fields.', details)),
    ).toEqual(details)
  })

  it('puts a taken address under the address field', () => {
    expect(
      createErrorFields(apiError(409, 'slug_taken', 'That address is taken. Pick another.')),
    ).toEqual({ slug: ['That address is taken. Pick another.'] })
  })

  it('puts a taken email under the owner email field', () => {
    expect(
      createErrorFields(apiError(409, 'email_taken', 'That email already has an account.')),
    ).toEqual({ 'owner.email': ['That email already has an account.'] })
  })

  it('returns null for errors that are not about a field', () => {
    expect(createErrorFields(apiError(500, 'internal', 'Something went wrong.'))).toBeNull()
    expect(createErrorFields(new Error('boom'))).toBeNull()
  })
})

describe('timezoneOptions', () => {
  it('puts US zones first and lists each zone once', () => {
    const options = timezoneOptions(['Europe/London', 'America/Phoenix', 'Asia/Tokyo'])
    expect(options.slice(0, US_TIMEZONES.length)).toEqual(US_TIMEZONES)
    expect(options.slice(US_TIMEZONES.length)).toEqual(['Europe/London', 'Asia/Tokyo'])
  })
})
```

`ApiError`'s constructor is `new ApiError(status, { code, message, details?, requestId? })` (`src/lib/api.ts`).

- [ ] **Step 3: Run the tests to see them fail**

Run: `npm test -- src/features/contractors`
Expected: FAIL. `./contractors` can't be resolved.

- [ ] **Step 4: Write the data hooks**

Create `src/features/contractors/api.ts`:

```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { api } from '@/lib/api'

// The superadmin's view of contractors (relay-api modules/tenants).

const TENANT_STATUSES = ['setup', 'live', 'suspended'] as const
export type TenantStatus = (typeof TENANT_STATUSES)[number]

const Tenant = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  status: z.enum(TENANT_STATUSES),
  contactEmail: z.string(),
  contactPhone: z.string(),
  createdAt: z.string(),
})
export type Tenant = z.infer<typeof Tenant>

const TenantList = z.object({ tenants: z.array(Tenant) })
const TenantResult = z.object({ tenant: Tenant })

const CreatedTenant = z.object({
  tenant: Tenant,
  owner: z.object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    temporaryPassword: z.string(),
  }),
})
export type CreatedTenant = z.infer<typeof CreatedTenant>

export type CreateTenantInput = {
  name: string
  slug: string
  timezone: string
  contactEmail: string
  contactPhone: string
  owner: { name: string; email: string }
}

const tenantsKey = ['admin', 'tenants']

export function useTenants() {
  return useQuery({ queryKey: tenantsKey, queryFn: () => api.get('/admin/tenants', TenantList) })
}

export function useCreateTenant() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateTenantInput) => api.post('/admin/tenants', input, CreatedTenant),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: tenantsKey }),
  })
}

export function useSetTenantStatus() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ tenantId, status }: { tenantId: string; status: TenantStatus }) =>
      api.patch(`/admin/tenants/${tenantId}/status`, { status }, TenantResult),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: tenantsKey }),
  })
}
```

- [ ] **Step 5: Write the logic module**

Create `src/features/contractors/contractors.ts`:

```ts
import type { FieldErrors } from '@/components/form-field'
import { ApiError } from '@/lib/api'
import type { TenantStatus } from './api'

// Decisions behind the admin page's contractor screens, kept apart so they can be tested.

export const STATUS_LABELS: Record<TenantStatus, string> = {
  setup: 'Setup',
  live: 'Live',
  suspended: 'Off',
}

// The one action the status control offers. Only turning off asks first.
export function statusAction(status: TenantStatus): {
  label: string
  to: TenantStatus
  confirm: boolean
} {
  switch (status) {
    case 'setup':
      return { label: 'Go live', to: 'live', confirm: false }
    case 'live':
      return { label: 'Turn off', to: 'suspended', confirm: true }
    case 'suspended':
      return { label: 'Turn on', to: 'live', confirm: false }
  }
}

export const TURN_OFF_MESSAGE =
  'Their booking page goes offline and their staff are signed out. You can turn them on again later.'

export function statusChangedNotice(name: string, status: TenantStatus): string {
  if (status === 'live') return `${name} is live.`
  if (status === 'suspended') return `${name} is turned off.`
  return `${name} is back in setup.`
}

export function filterContractors<T extends { name: string; slug: string }>(
  list: T[],
  query: string,
): T[] {
  const words = query.trim().toLowerCase()
  if (!words) return list
  return list.filter(
    (tenant) => tenant.name.toLowerCase().includes(words) || tenant.slug.includes(words),
  )
}

// The create form's field errors for an API error, or null when it isn't about a field.
export function createErrorFields(error: unknown): FieldErrors | null {
  if (!(error instanceof ApiError)) return null
  if (error.code === 'validation_failed') return error.details
  if (error.code === 'slug_taken') return { slug: [error.message] }
  if (error.code === 'email_taken') return { 'owner.email': [error.message] }
  return null
}

// Most contractors are in the US, so their zones come first.
export const US_TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
]

export function timezoneOptions(all: string[] = Intl.supportedValuesOf('timeZone')): string[] {
  return [...US_TIMEZONES, ...all.filter((zone) => !US_TIMEZONES.includes(zone))]
}

// The admin's own zone if it's a known one, otherwise Phoenix like the demo contractor.
export function defaultTimezone(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  return timezoneOptions().includes(zone) ? zone : 'America/Phoenix'
}
```

- [ ] **Step 6: Move `useTenants` out of branding**

In `src/features/branding/api.ts`, delete the `TenantList` schema and the `useTenants` function. `src/routes/admin.tsx` still imports `useTenants` from branding until Task 5, so in the same step change that import line in `src/routes/admin.tsx` to:

```ts
import { useTenantBranding } from '@/features/branding/api'
import { useTenants } from '@/features/contractors/api'
```

- [ ] **Step 7: Run the tests to see them pass**

Run: `npm test -- src/features/contractors`
Expected: PASS.

- [ ] **Step 8: Check and commit**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all pass.

```bash
git add src/features/contractors src/features/branding/api.ts src/routes/admin.tsx
git commit -m "feat: add the contractor data hooks and admin page logic

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Web – contractor list with search, and the status control

Repo: relay-web.

**Files:**
- Create: `src/features/contractors/contractor-list.tsx`
- Create: `src/features/contractors/status-control.tsx`
- Modify: `src/routes/admin.tsx`

**Interfaces:**
- Consumes: Task 4's `Tenant`, `TenantStatus`, `useTenants`, `useSetTenantStatus`, `STATUS_LABELS`, `statusAction`, `statusChangedNotice`, `TURN_OFF_MESSAGE`, `filterContractors`. `ConfirmDialog`/`Confirmation` from `@/components/confirm-dialog`. `Badge` (`variant`: `default | secondary | destructive | outline`) from `@/components/ui/badge`. `CardAction` from `@/components/ui/card`. `errorMessage` from `@/lib/errors`. `toast` from `sonner`.
- Produces: `ContractorList({ tenants, selectedId, onSelect })`, `StatusBadge({ status })`, `StatusControl({ tenant })`. `AdminPage` has state `adding`/`setAdding`, which Task 6 wires to the dialog.

These are components; relay-web has no component tests. Their logic is tested in Task 4. This task is checked with typecheck, lint and a manual run.

- [ ] **Step 1: Write the list**

Create `src/features/contractors/contractor-list.tsx`:

```tsx
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type { Tenant, TenantStatus } from './api'
import { filterContractors, STATUS_LABELS } from './contractors'

const BADGE_VARIANTS = {
  setup: 'secondary',
  live: 'default',
  suspended: 'destructive',
} as const

export function StatusBadge({ status }: { status: TenantStatus }) {
  return <Badge variant={BADGE_VARIANTS[status]}>{STATUS_LABELS[status]}</Badge>
}

// Every contractor with its status. Searching filters by name or address.
export function ContractorList({
  tenants,
  selectedId,
  onSelect,
}: {
  tenants: Tenant[]
  selectedId: string | undefined
  onSelect: (tenantId: string) => void
}) {
  const [query, setQuery] = useState('')
  const shown = filterContractors(tenants, query)

  return (
    <div className="space-y-2">
      <Input
        type="search"
        aria-label="Search contractors"
        placeholder="Search by name or address"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <ul className="divide-y rounded-lg border">
        {shown.map((tenant) => (
          <li key={tenant.id}>
            <button
              type="button"
              aria-pressed={tenant.id === selectedId}
              onClick={() => onSelect(tenant.id)}
              className={cn(
                'flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-muted',
                tenant.id === selectedId && 'bg-muted',
              )}
            >
              <span className="min-w-0">
                <span className="block truncate font-medium">{tenant.name}</span>
                <span className="block truncate text-sm text-muted-foreground">
                  {tenant.slug}.garified.com
                </span>
              </span>
              <StatusBadge status={tenant.status} />
            </button>
          </li>
        ))}
        {shown.length === 0 && (
          <li className="px-3 py-2 text-sm text-muted-foreground">
            {tenants.length === 0 ? 'No contractors yet.' : 'No contractors match your search.'}
          </li>
        )}
      </ul>
    </div>
  )
}
```

- [ ] **Step 2: Write the status control**

Create `src/features/contractors/status-control.tsx`:

```tsx
import { useState } from 'react'
import { toast } from 'sonner'
import { type Confirmation, ConfirmDialog } from '@/components/confirm-dialog'
import { Button } from '@/components/ui/button'
import { errorMessage } from '@/lib/errors'
import { type Tenant, useSetTenantStatus } from './api'
import { StatusBadge } from './contractor-list'
import { statusAction, statusChangedNotice, TURN_OFF_MESSAGE } from './contractors'

// The contractor's status and the one move from it: go live, turn off or turn on.
export function StatusControl({ tenant }: { tenant: Tenant }) {
  const setStatus = useSetTenantStatus()
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const action = statusAction(tenant.status)

  function apply() {
    setStatus.mutate(
      { tenantId: tenant.id, status: action.to },
      {
        onSuccess: () => toast.success(statusChangedNotice(tenant.name, action.to)),
        onError: (error) => toast.error(errorMessage(error)),
      },
    )
  }

  function onClick() {
    if (!action.confirm) return apply()
    setConfirmation({
      title: `Turn off ${tenant.name}?`,
      message: TURN_OFF_MESSAGE,
      confirmLabel: 'Turn off',
      destructive: true,
      onConfirm: apply,
    })
  }

  return (
    <div className="flex items-center gap-2">
      <StatusBadge status={tenant.status} />
      <Button
        size="sm"
        variant={action.confirm ? 'outline' : 'default'}
        disabled={setStatus.isPending}
        onClick={onClick}
      >
        {action.label}
      </Button>
      <ConfirmDialog confirmation={confirmation} onClose={() => setConfirmation(null)} />
    </div>
  )
}
```

- [ ] **Step 3: Use them on the admin page**

Replace `src/routes/admin.tsx` with:

```tsx
import { useState } from 'react'
import { PageShell } from '@/components/page-shell'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { SignOutButton } from '@/features/auth/sign-out-button'
import { useTenantBranding } from '@/features/branding/api'
import { BrandingForm } from '@/features/branding/branding-form'
import { type Tenant, useTenants } from '@/features/contractors/api'
import { ContractorList } from '@/features/contractors/contractor-list'
import { StatusControl } from '@/features/contractors/status-control'

// Relay admin console: find or add a contractor, set its status and brand colors.
export function AdminPage() {
  const tenants = useTenants()
  const [pickedId, setPickedId] = useState<string>()
  const [adding, setAdding] = useState(false)
  const list = tenants.data?.tenants ?? []
  const selected = list.find((tenant) => tenant.id === pickedId) ?? list[0]

  if (tenants.isError) throw tenants.error

  return (
    <PageShell
      title="Contractors"
      actions={
        <div className="flex gap-2">
          <Button onClick={() => setAdding(true)}>Add contractor</Button>
          <SignOutButton />
        </div>
      }
    >
      <div className="grid items-start gap-4 md:grid-cols-[18rem_1fr]">
        <ContractorList tenants={list} selectedId={selected?.id} onSelect={setPickedId} />
        {selected && <TenantCard key={selected.id} tenant={selected} />}
      </div>
      {adding && null}
    </PageShell>
  )
}

function TenantCard({ tenant }: { tenant: Tenant }) {
  const branding = useTenantBranding(tenant.id)

  if (branding.isError) throw branding.error

  return (
    <Card>
      <CardHeader>
        <CardTitle>{tenant.name}</CardTitle>
        <CardDescription>{tenant.slug}.garified.com</CardDescription>
        <CardAction>
          <StatusControl tenant={tenant} />
        </CardAction>
      </CardHeader>
      <CardContent>
        {branding.data && <BrandingForm tenantId={tenant.id} current={branding.data} />}
      </CardContent>
    </Card>
  )
}
```

`{adding && null}` holds the place for the dialog that Task 6 adds. It keeps `adding` used so lint passes. Task 6 replaces it.

- [ ] **Step 4: Check it**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all pass.

Manual check, with relay-api on `feat/contractor-lifecycle` running (`npm run dev` in each repo), signed in as `admin@relay.test` / `relay-dev-password` at `http://localhost:5173/admin`:
- The list shows Desert Breeze Air with a "Setup" badge. Typing `xyz` in search shows "No contractors match your search."
- "Go live" turns the badge to "Live" with a toast. "Turn off" asks first; confirming shows "Off". "Turn on" brings back "Live".

- [ ] **Step 5: Commit**

```bash
git add src/features/contractors/contractor-list.tsx src/features/contractors/status-control.tsx src/routes/admin.tsx
git commit -m "feat: list contractors with search and let the admin turn them on and off

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Web – add contractor dialog

Repo: relay-web.

**Files:**
- Create: `src/features/contractors/create-contractor-dialog.tsx`
- Modify: `src/routes/admin.tsx`

**Interfaces:**
- Consumes: Task 4's `useCreateTenant`, `CreatedTenant`, `createErrorFields`, `timezoneOptions`, `defaultTimezone`. `Field`, `FieldErrors` from `@/components/form-field`; `Dialog*` from `@/components/ui/dialog` (`DialogContent` takes `showCloseButton`); `Input`; `NativeSelect` from `@/components/ui/native-select`; `errorMessage`; `toast`.
- Produces: `CreateContractorDialog({ open, onClose, onCreated })`, where `onCreated(tenantId: string)` runs when the admin closes the "created" view.

- [ ] **Step 1: Write the dialog**

Create `src/features/contractors/create-contractor-dialog.tsx`:

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
import { NativeSelect } from '@/components/ui/native-select'
import { errorMessage } from '@/lib/errors'
import { type CreatedTenant, useCreateTenant } from './api'
import { createErrorFields, defaultTimezone, timezoneOptions } from './contractors'

// Adds a contractor and its first owner, then shows the owner's temporary password once.
// While the password is shown, only "Done" closes the dialog, so it isn't lost by a stray
// click outside.
export function CreateContractorDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  onCreated: (tenantId: string) => void
}) {
  const [created, setCreated] = useState<CreatedTenant | null>(null)

  function finish() {
    if (created) onCreated(created.tenant.id)
    setCreated(null)
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !created && onClose()}>
      <DialogContent
        showCloseButton={!created}
        className="max-h-[90dvh] overflow-y-auto sm:max-w-md"
      >
        {created ? (
          <CreatedView created={created} onDone={finish} />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Add contractor</DialogTitle>
              <DialogDescription>
                They start in setup: the booking page works so you can check it, and you take
                them live when they’re ready.
              </DialogDescription>
            </DialogHeader>
            {/* Mounted only while open, so each opening starts empty. */}
            {open && <CreateForm onCreated={setCreated} onCancel={onClose} />}
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function CreateForm({
  onCreated,
  onCancel,
}: {
  onCreated: (created: CreatedTenant) => void
  onCancel: () => void
}) {
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [timezone, setTimezone] = useState(defaultTimezone)
  const [contactEmail, setContactEmail] = useState('')
  const [contactPhone, setContactPhone] = useState('')
  const [ownerName, setOwnerName] = useState('')
  const [ownerEmail, setOwnerEmail] = useState('')
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const create = useCreateTenant()

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    try {
      onCreated(
        await create.mutateAsync({
          name,
          slug,
          timezone,
          contactEmail,
          contactPhone,
          owner: { name: ownerName, email: ownerEmail },
        }),
      )
    } catch (error) {
      const fields = createErrorFields(error)
      setFieldErrors(fields ?? {})
      if (!fields) toast.error(errorMessage(error))
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <Field id="contractor-name" label="Company name" errors={fieldErrors.name}>
        <Input
          id="contractor-name"
          autoComplete="off"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <Field id="contractor-slug" label="Booking page address" errors={fieldErrors.slug}>
        <div className="flex items-center gap-1">
          <Input
            id="contractor-slug"
            autoComplete="off"
            placeholder="desert"
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
          />
          <span className="text-sm text-muted-foreground">.garified.com</span>
        </div>
      </Field>
      <Field id="contractor-timezone" label="Time zone" errors={fieldErrors.timezone}>
        <NativeSelect
          id="contractor-timezone"
          value={timezone}
          onChange={(event) => setTimezone(event.target.value)}
        >
          {timezoneOptions().map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field id="contractor-email" label="Office email" errors={fieldErrors.contactEmail}>
        <Input
          id="contractor-email"
          type="email"
          value={contactEmail}
          onChange={(event) => setContactEmail(event.target.value)}
        />
      </Field>
      <Field id="contractor-phone" label="Office phone" errors={fieldErrors.contactPhone}>
        <Input
          id="contractor-phone"
          type="tel"
          placeholder="(480) 555-0199"
          value={contactPhone}
          onChange={(event) => setContactPhone(event.target.value)}
        />
      </Field>
      <Field id="owner-name" label="Owner’s name" errors={fieldErrors['owner.name']}>
        <Input
          id="owner-name"
          autoComplete="off"
          value={ownerName}
          onChange={(event) => setOwnerName(event.target.value)}
        />
      </Field>
      <Field id="owner-email" label="Owner’s sign-in email" errors={fieldErrors['owner.email']}>
        <Input
          id="owner-email"
          type="email"
          value={ownerEmail}
          onChange={(event) => setOwnerEmail(event.target.value)}
        />
      </Field>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? 'Adding…' : 'Add contractor'}
        </Button>
      </DialogFooter>
    </form>
  )
}

function CreatedView({ created, onDone }: { created: CreatedTenant; onDone: () => void }) {
  const { tenant, owner } = created

  function copyPassword() {
    navigator.clipboard.writeText(owner.temporaryPassword).then(
      () => toast.success('Password copied'),
      () => toast.error('Couldn’t copy. Select the password and copy it.'),
    )
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{tenant.name} added</DialogTitle>
        <DialogDescription>
          This password is shown only once. Send it to the owner now.
        </DialogDescription>
      </DialogHeader>
      <dl className="space-y-3 text-sm">
        <div>
          <dt className="text-muted-foreground">Sign-in email</dt>
          <dd className="font-medium">{owner.email}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Temporary password</dt>
          <dd className="flex items-center gap-2">
            <code className="rounded bg-muted px-2 py-1 font-mono text-base select-all">
              {owner.temporaryPassword}
            </code>
            <Button type="button" size="sm" variant="outline" onClick={copyPassword}>
              Copy
            </Button>
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Booking page</dt>
          <dd className="font-medium">{tenant.slug}.garified.com</dd>
        </div>
      </dl>
      <DialogFooter>
        <Button onClick={onDone}>Done</Button>
      </DialogFooter>
    </>
  )
}
```

- [ ] **Step 2: Wire it into the admin page**

In `src/routes/admin.tsx`, add the import:

```ts
import { CreateContractorDialog } from '@/features/contractors/create-contractor-dialog'
```

and replace `{adding && null}` with:

```tsx
      <CreateContractorDialog
        open={adding}
        onClose={() => setAdding(false)}
        onCreated={setPickedId}
      />
```

- [ ] **Step 3: Check it**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all pass.

Manual check at `http://localhost:5173/admin` as the superadmin:
- Submit an empty form: errors show under the company name, address, office email, office phone, owner's name and owner email fields.
- Use address `desert`: "That address is taken. Pick another." under the address field.
- Use owner email `owner@desert.test`: "That email already has an account." under the owner email field.
- Valid input: the "added" view shows the password; Copy shows a toast; clicking outside or pressing Escape does not close it; Done closes it and selects the new contractor in the list with a "Setup" badge.
- Sign out and sign in as the new owner with the temporary password: it works.

- [ ] **Step 4: Commit**

```bash
git add src/features/contractors/create-contractor-dialog.tsx src/routes/admin.tsx
git commit -m "feat: add contractors from the admin page

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Web – booking page of a turned-off contractor

Repo: relay-web.

**Files:**
- Modify: `src/routes/booking.tsx`

**Interfaces:**
- Consumes: Task 3's `410 contractor_unavailable` from `GET /api/branding`. relay-web's QueryClient doesn't retry 4xx (`src/main.tsx`), so the page shows at once.
- Produces: nothing used later.

- [ ] **Step 1: Show a plain page for `contractor_unavailable`**

In `src/routes/booking.tsx`, add before `if (branding.isError) throw branding.error`:

```tsx
  if (branding.error instanceof ApiError && branding.error.code === 'contractor_unavailable') {
    return (
      <PageShell title="Booking unavailable">
        <p className="text-muted-foreground">This booking page isn’t available right now.</p>
      </PageShell>
    )
  }
```

and update the component comment's last sentence to: `"Contractor not found" and a turned-off contractor keep the plain PageShell: there is no wizard to show.`

- [ ] **Step 2: Check it**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all pass.

Manual check: turn off Desert Breeze Air in the admin page, open `http://desert.localhost:5173/`. Expected: "Booking unavailable", "This booking page isn’t available right now." Signing in as `owner@desert.test` shows "Your company’s account is turned off. Contact Relay support." Turn it on again: the booking page and sign-in work.

- [ ] **Step 3: Commit**

```bash
git add src/routes/booking.tsx
git commit -m "feat: tell homeowners when a contractor's booking page is off

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
