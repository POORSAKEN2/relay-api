# Booking Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status (2026-09-30):** Tasks 1 to 4 are built and their checks pass (API 181 tests, web 60 tests). Task 5: the migration is applied to the development database; the ten-line walkthrough in a browser (Task 5, Step 3) has not been done yet. Committed on `feat/online-booking` in both repositories, not pushed.

**Goal:** Save an unfinished online booking as a draft, let the homeowner resume it, queue one recovery text for drafts left unfinished, and give the wizard an Exit button.

**Architecture:** `relay-api` gets a `booking_drafts` table, three draft routes in the existing `online-booking` module, a temporary `sendText()` that only saves a `queued` message, and a `pg-boss` job that runs every 5 minutes. `relay-web` gets a new `contact` step after the ZIP check that creates the draft, background saves of later answers, a resume path from `?resume=<token>` or `localStorage`, and an Exit dialog.

**Tech Stack:** API: Node 22, Express 5, Drizzle ORM, PostgreSQL, Zod 4, pg-boss, Vitest + supertest. Web: React 19, React Router, TanStack Query, Tailwind 4, Base UI dialog, lucide-react, Vitest (node environment, no DOM).

**Spec:** `relay-api/docs/superpowers/specs/2026-09-30-booking-recovery-design.md`. Later work: `relay-api/docs/real-texting-todo.md`.

## Global Constraints

- Two separate git repositories: `relay/relay-api` and `relay/relay-web`, both on branch `feat/online-booking` with uncommitted work that predates this plan. **Do not commit.** Each task ends with a checkpoint (tests green). Committing is the user's call. If asked to commit: no `Co-Authored-By` trailer and no "Generated with Claude Code" line.
- Lean, simple code. No new libraries. A junior developer must be able to debug it without AI.
- Match the surrounding code: comment style, naming, one responsibility per file. API modules are `*.routes.ts`, `*.schemas.ts`, `*.service.ts`, `*.queries.ts`; every tenant query takes `tenantId` first.
- Text consent is optional and never a condition of booking. Only a draft with `sms_consent` true is ever texted.
- No real text is sent. The wizard must never promise a text.
- Constants, copied from the spec: recovery waits **60 minutes** after the last activity, stops **24 hours** after the draft began, and the job runs every **5 minutes** (`*/5 * * * *`).
- Format only the files a task touches: `npx biome check --write <paths>`. Running it on all of `src` rewrites line endings in unrelated files.
- API checks (run in `relay-api`): `npx tsc --noEmit`, `npx vitest run <file>`. Web checks (run in `relay-web`): `npx tsc -b`, `npx vitest run`.

## File Structure

**relay-api**

| File | Change | Responsibility |
| --- | --- | --- |
| `src/db/schema.ts` | modify | `bookingDrafts` table and `DraftAnswers` type |
| `drizzle/0006_booking_drafts.sql` (+ meta) | generate | the migration |
| `src/modules/online-booking/online-booking.schemas.ts` | modify | `DraftInput`, `DraftAnswersInput`, `draftToken` on `BookingInput` |
| `src/modules/online-booking/online-booking.queries.ts` | modify | draft queries |
| `src/modules/online-booking/online-booking.service.ts` | modify | draft services, `recordConsent`, `sendRecoveryTexts`, `bookingLink` |
| `src/modules/online-booking/online-booking.routes.ts` | modify | three draft routes, their rate limit |
| `src/modules/online-booking/booking-drafts.test.ts` | create | all tests for this plan's API work |
| `src/modules/messaging/sms.ts` | create | temporary `sendText()` |
| `src/jobs/index.ts` | modify | register `booking-recovery` |

**relay-web** (all under `src/features/booking/`)

| File | Change | Responsibility |
| --- | --- | --- |
| `steps.ts`, `steps.test.ts` | modify | the `contact` step, `draftAnswers`, `answersFromDraft` |
| `draft-token.ts`, `draft-token.test.ts` | create | the stored draft token |
| `api.ts` | modify | draft hooks, `draftToken` on the booking |
| `contact-step.tsx` | create | step 3: name, mobile, consent |
| `details-step.tsx` | modify | loses name, phone, consent |
| `booking-progress.tsx` | modify | sixth dot |
| `time-step.tsx` | modify | waitlist form starts with the known name and phone |
| `booking-flow.tsx` | modify | loader + wizard, saving, resume, Exit |
| `booking-exit.tsx` | create | `ExitDialog`, `LeftScreen` |

---

### Task 1: Drafts in the API

**Files:**
- Modify: `relay-api/src/db/schema.ts` (after `callbackRequests`, about line 760)
- Generate: `relay-api/drizzle/0006_booking_drafts.sql`
- Modify: `relay-api/src/modules/online-booking/online-booking.schemas.ts`
- Modify: `relay-api/src/modules/online-booking/online-booking.queries.ts`
- Modify: `relay-api/src/modules/online-booking/online-booking.service.ts`
- Modify: `relay-api/src/modules/online-booking/online-booking.routes.ts`
- Test: `relay-api/src/modules/online-booking/booking-drafts.test.ts`

**Interfaces:**
- Consumes: `zipIsServed`, `booking.insertConsent`, `audit.insertHomeownerAction`, `CONSENT_WORDING`, `bookVisit` (all existing).
- Produces:
  - table `bookingDrafts` with columns `id, tenantId, token, name, phone, zip, answers, smsConsent, lastActivityAt, recoveryTextedAt, bookedJobId, createdAt`; type `DraftAnswers`.
  - `POST /api/online-booking/drafts` body `{ name, phone, zip, consent?, token? }` → `201 { token }`
  - `GET /api/online-booking/drafts/:token` → `200 { name, phone, zip, consent, answers }`
  - `PATCH /api/online-booking/drafts/:token` body `{ answers }` → `200 { ok: true }`
  - `POST /api/online-booking/bookings` accepts optional `draftToken: string`.
  - queries `findOpenDraft(tenantId, token, tx?)`, `insertDraft(tenantId, values, tx?)`, `updateDraft(tenantId, draftId, values, tx?)`, `markDraftBooked(tenantId, draftId, jobId, tx)`.

- [ ] **Step 1: Add the table to `src/db/schema.ts`**

Insert after the `callbackRequests` table:

```ts
// What the booking wizard has been told so far. Every key is optional: a draft starts empty.
// The arrival window is left out on purpose: open windows change, so a homeowner who comes
// back picks one again.
export type DraftAnswers = {
  serviceId?: string
  problem?: string
  systemType?: (typeof SYSTEM_TYPES)[number]
  vulnerableOccupant?: boolean
  priorityService?: boolean
}

// An online booking somebody started and hasn't finished. Saved once they give a name and
// phone, so a refresh resumes it and a recovery text can bring them back.
export const bookingDrafts = pgTable(
  'booking_drafts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    // 32 random bytes as hex: the only key the browser and the resume link know. Stored as it
    // is, unlike job links: the recovery job needs it to build the link, and it opens nothing
    // this row doesn't already hold.
    token: text('token').notNull().unique(),
    name: text('name').notNull(),
    phone: text('phone').notNull(),
    zip: text('zip').notNull(),
    answers: jsonb('answers').$type<DraftAnswers>().notNull().default({}),
    smsConsent: boolean('sms_consent').notNull().default(false), // proof is in consent_events
    lastActivityAt: timestamptz('last_activity_at').notNull().defaultNow(),
    recoveryTextedAt: timestamptz('recovery_texted_at'), // null = not texted yet
    bookedJobId: uuid('booked_job_id'), // set when the booking is made
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'booking_drafts_booked_job_fk',
      columns: [t.tenantId, t.bookedJobId],
      foreignColumns: [jobs.tenantId, jobs.id],
    }),
    check('booking_drafts_phone_e164', e164(t.phone)),
    check('booking_drafts_zip_format', sql`${t.zip} ~ '^[0-9]{5}$'`),
    // The recovery job's queue: drafts that may still get their one text.
    index('booking_drafts_recovery_idx')
      .on(t.lastActivityAt)
      .where(
        sql`${t.smsConsent} and ${t.bookedJobId} is null and ${t.recoveryTextedAt} is null`,
      ),
  ],
)
```

- [ ] **Step 2: Generate the migration and check the SQL**

Run (in `relay-api`): `npm run db:generate -- --name booking_drafts`

Expected: a new `drizzle/0006_booking_drafts.sql` and `drizzle/meta/0006_snapshot.json`. The SQL must be this, give or take whitespace. If it contains anything about another table, stop and report.

```sql
CREATE TABLE "booking_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"token" text NOT NULL,
	"name" text NOT NULL,
	"phone" text NOT NULL,
	"zip" text NOT NULL,
	"answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sms_consent" boolean DEFAULT false NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recovery_texted_at" timestamp with time zone,
	"booked_job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_drafts_token_unique" UNIQUE("token"),
	CONSTRAINT "booking_drafts_phone_e164" CHECK ("booking_drafts"."phone" ~ '^\+[1-9][0-9]{7,14}$'),
	CONSTRAINT "booking_drafts_zip_format" CHECK ("booking_drafts"."zip" ~ '^[0-9]{5}$')
);
--> statement-breakpoint
ALTER TABLE "booking_drafts" ADD CONSTRAINT "booking_drafts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_drafts" ADD CONSTRAINT "booking_drafts_booked_job_fk" FOREIGN KEY ("tenant_id","booked_job_id") REFERENCES "public"."jobs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "booking_drafts_recovery_idx" ON "booking_drafts" USING btree ("last_activity_at") WHERE "booking_drafts"."sms_consent" and "booking_drafts"."booked_job_id" is null and "booking_drafts"."recovery_texted_at" is null;
```

The test database migrates by itself when tests start (`test/global-setup.ts`). The development database is migrated in Task 5.

- [ ] **Step 3: Write the failing tests**

Create `src/modules/online-booking/booking-drafts.test.ts`:

```ts
import { eq } from 'drizzle-orm'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createShop, resetDb, type Shop, TUESDAY } from '../../../test/helpers.ts'
import { createApp } from '../../app.ts'
import { db } from '../../db/client.ts'
import {
  auditEvents,
  bookingDrafts,
  consentEvents,
  jobs,
  serviceAreaZips,
} from '../../db/schema.ts'
import { CONSENT_WORDING } from './online-booking.service.ts'

vi.mock('../../realtime/index.ts', () => ({ emitToTenant: vi.fn() }))

const app = createApp()

beforeEach(async () => {
  await resetDb()
})

// The booking page has no sign-in: the contractor comes from the web address.
function call(method: 'get' | 'post' | 'patch', path: string, slug = 'desert') {
  return request(app)
    [method](`/api/online-booking/${path}`)
    .set('X-Tenant-Host', `${slug}.localhost`)
}

// A shop that serves Mesa (85201) and downtown Phoenix (85004).
async function createServingShop(slug = 'desert') {
  const shop = await createShop(slug)
  await db
    .insert(serviceAreaZips)
    .values(['85004', '85201'].map((zip) => ({ tenantId: shop.tenant.id, zip })))
  return shop
}

function draftBody(overrides: Record<string, unknown> = {}) {
  return { name: 'Sam Reed', phone: '(480) 555-0199', zip: '85201', consent: true, ...overrides }
}

function bookingBody(shop: Shop, overrides: Record<string, unknown> = {}) {
  return {
    serviceId: shop.service.id,
    date: TUESDAY,
    windowId: shop.tueMorning.id,
    problem: 'No cooling since last night',
    systemType: 'central_ac',
    name: 'Sam Reed',
    phone: '(480) 555-0199',
    street: '4 Cactus Rd',
    city: 'Mesa',
    state: 'AZ',
    zip: '85201',
    consent: true,
    ...overrides,
  }
}

describe('POST /api/online-booking/drafts', () => {
  it('saves who started a booking, with their consent', async () => {
    const shop = await createServingShop()

    const res = await call('post', 'drafts').send(draftBody()).expect(201)
    expect(res.body.token).toMatch(/^[0-9a-f]{64}$/)

    const [draft] = await db.select().from(bookingDrafts)
    expect(draft).toMatchObject({
      tenantId: shop.tenant.id,
      token: res.body.token,
      name: 'Sam Reed',
      phone: '+14805550199',
      zip: '85201',
      smsConsent: true,
      answers: {},
      recoveryTextedAt: null,
      bookedJobId: null,
    })

    const consent = await db.select().from(consentEvents)
    expect(consent.map((event) => event.channel).sort()).toEqual(['sms', 'voice'])
    for (const event of consent) {
      expect(event).toMatchObject({
        contact: '+14805550199',
        granted: true,
        source: 'booking_form',
        wording: CONSENT_WORDING,
        jobId: null,
      })
    }
    expect(await db.select().from(auditEvents)).toEqual([
      expect.objectContaining({
        actorType: 'homeowner',
        action: 'booking_draft.created',
        entityId: draft.id,
      }),
    ])
  })

  it('saves a draft without consent and records none', async () => {
    await createServingShop()

    await call('post', 'drafts').send(draftBody({ consent: false })).expect(201)

    const [draft] = await db.select().from(bookingDrafts)
    expect(draft.smsConsent).toBe(false)
    expect(await db.select().from(consentEvents)).toHaveLength(0)
  })

  it('updates the same draft when the homeowner comes back to the step', async () => {
    await createServingShop()
    const first = await call('post', 'drafts').send(draftBody()).expect(201)

    const second = await call('post', 'drafts')
      .send(draftBody({ name: 'Samantha Reed', zip: '85004', consent: false, token: first.body.token }))
      .expect(201)

    expect(second.body.token).toBe(first.body.token)
    const drafts = await db.select().from(bookingDrafts)
    expect(drafts).toHaveLength(1)
    expect(drafts[0]).toMatchObject({ name: 'Samantha Reed', zip: '85004', smsConsent: false })
    // Ticked, then unticked: two rows granting and two taking it back.
    const consent = await db.select().from(consentEvents)
    expect(consent.map((event) => event.granted).sort()).toEqual([false, false, true, true])
  })

  it('refuses a ZIP code outside the service area and a bad phone number', async () => {
    await createServingShop()

    const outside = await call('post', 'drafts').send(draftBody({ zip: '90210' })).expect(422)
    expect(outside.body.error.code).toBe('outside_area')

    const bad = await call('post', 'drafts').send(draftBody({ phone: '555' })).expect(400)
    expect(bad.body.error.details.phone).toEqual(['Enter a 10-digit phone number'])
    expect(await db.select().from(bookingDrafts)).toHaveLength(0)
  })
})

describe('GET and PATCH /api/online-booking/drafts/:token', () => {
  it('saves the answers and gives the draft back', async () => {
    const shop = await createServingShop()
    const { body } = await call('post', 'drafts').send(draftBody()).expect(201)
    const [before] = await db.select().from(bookingDrafts)
    const answers = { serviceId: shop.service.id, problem: 'No cooling', systemType: 'central_ac' }

    await call('patch', `drafts/${body.token}`).send({ answers }).expect(200, { ok: true })

    const res = await call('get', `drafts/${body.token}`).expect(200)
    expect(res.body).toEqual({
      name: 'Sam Reed',
      phone: '+14805550199',
      zip: '85201',
      consent: true,
      answers,
    })
    const [after] = await db.select().from(bookingDrafts)
    expect(after.lastActivityAt.getTime()).toBeGreaterThanOrEqual(before.lastActivityAt.getTime())
  })

  it('refuses answers that are not the wizard’s', async () => {
    await createServingShop()
    const { body } = await call('post', 'drafts').send(draftBody()).expect(201)

    await call('patch', `drafts/${body.token}`)
      .send({ answers: { systemType: 'toaster' } })
      .expect(400)
  })

  it('hides a draft from an unknown token and from another contractor', async () => {
    await createServingShop()
    await createServingShop('other')
    const { body } = await call('post', 'drafts').send(draftBody()).expect(201)

    await call('get', 'drafts/nope').expect(404)
    await call('get', `drafts/${body.token}`, 'other').expect(404)
    await call('patch', `drafts/${body.token}`, 'other').send({ answers: {} }).expect(404)
  })
})

describe('POST /api/online-booking/bookings with a draft', () => {
  it('marks the draft as booked, so it can’t be resumed', async () => {
    const shop = await createServingShop()
    const { body } = await call('post', 'drafts').send(draftBody()).expect(201)

    const res = await call('post', 'bookings')
      .send(bookingBody(shop, { draftToken: body.token }))
      .expect(201)

    const [draft] = await db.select().from(bookingDrafts)
    expect(draft.bookedJobId).toBe(res.body.jobId)
    await call('get', `drafts/${body.token}`).expect(404)
  })

  it('still books when the draft token is unknown', async () => {
    const shop = await createServingShop()

    const res = await call('post', 'bookings')
      .send(bookingBody(shop, { draftToken: 'nope' }))
      .expect(201)

    const [job] = await db.select().from(jobs).where(eq(jobs.id, res.body.jobId))
    expect(job.status).toBe('booked')
  })
})
```

- [ ] **Step 4: Run the tests to see them fail**

Run: `npx vitest run src/modules/online-booking/booking-drafts.test.ts`
Expected: FAIL. The draft routes answer `404 Route not found`, so every `expect(201)` on `drafts` fails.

- [ ] **Step 5: Add the input schemas**

In `online-booking.schemas.ts`, add after `WaitlistInput`:

```ts
// Step 3: who is booking. Saved as a draft so an unfinished booking isn't lost. `token` is the
// draft this browser already has, sent when the homeowner comes back to the step.
export const DraftInput = z.object({
  name: Name,
  phone: UsPhone,
  zip: Zip,
  consent: z.boolean().default(false),
  token: z.string().optional(),
})
export type DraftInput = z.infer<typeof DraftInput>

// The answers a draft keeps (DraftAnswers in schema.ts). Anything else is dropped.
export const DraftAnswersInput = z.object({
  answers: z.object({
    serviceId: z.uuid().optional(),
    problem: z.string().trim().max(2000).optional(),
    systemType: z.enum(SYSTEM_TYPES).optional(),
    vulnerableOccupant: z.boolean().optional(),
    priorityService: z.boolean().optional(),
  }),
})
```

In `BookingInput`, add one line after `consent`:

```ts
  consent: z.boolean().default(false),
  draftToken: z.string().optional(), // the draft this booking finishes, when there is one
```

- [ ] **Step 6: Add the queries**

In `online-booking.queries.ts`, change the schema import to include `bookingDrafts`:

```ts
import {
  bookingDrafts,
  callbackRequests,
  jobs,
  services,
  waitlistEntries,
} from '../../db/schema.ts'
```

Add before `expireHolds`:

```ts
export async function insertDraft(
  tenantId: string,
  values: Omit<typeof bookingDrafts.$inferInsert, 'tenantId'>,
  tx: Db = db,
) {
  const [draft] = await tx
    .insert(bookingDrafts)
    .values({ ...values, tenantId })
    .returning()
  return draft
}

// The draft behind a token, unless its booking was already made.
export async function findOpenDraft(tenantId: string, token: string, tx: Db = db) {
  const [draft] = await tx
    .select()
    .from(bookingDrafts)
    .where(
      and(
        eq(bookingDrafts.tenantId, tenantId),
        eq(bookingDrafts.token, token),
        isNull(bookingDrafts.bookedJobId),
      ),
    )
  return draft
}

// Something the homeowner changed. It counts as activity, which restarts the recovery wait.
export async function updateDraft(
  tenantId: string,
  draftId: string,
  values: Partial<
    Pick<typeof bookingDrafts.$inferInsert, 'name' | 'phone' | 'zip' | 'smsConsent' | 'answers'>
  >,
  tx: Db = db,
) {
  await tx
    .update(bookingDrafts)
    .set({ ...values, lastActivityAt: new Date() })
    .where(and(eq(bookingDrafts.tenantId, tenantId), eq(bookingDrafts.id, draftId)))
}

export async function markDraftBooked(tenantId: string, draftId: string, jobId: string, tx: Db) {
  await tx
    .update(bookingDrafts)
    .set({ bookedJobId: jobId })
    .where(and(eq(bookingDrafts.tenantId, tenantId), eq(bookingDrafts.id, draftId)))
}
```

- [ ] **Step 7: Add the services**

In `online-booking.service.ts`:

Add to the imports:

```ts
import { randomBytes } from 'node:crypto'
import type { DraftAnswers, Tenant } from '../../db/schema.ts'
import type {
  BookingInput,
  CallbackInput,
  DraftInput,
  WaitlistInput,
} from './online-booking.schemas.ts'
```

(The existing `import type { Tenant }` and the existing schemas import are replaced by these.)

Add after `SERVICE_GONE`:

```ts
const DRAFT_GONE = 'That saved booking isn’t available anymore. Start a new one.'
```

Add after `joinWaitlist`:

```ts
// Step 3: saves who started a booking, so it isn't lost if they stop. Coming back to the step
// with the same draft updates it; no token, or one we don't know, starts a new draft.
export async function saveDraftContact(tenant: Tenant, input: DraftInput, ip: string | null) {
  await checkZipServed(tenant.id, input.zip)
  const contact = {
    name: input.name,
    phone: input.phone,
    zip: input.zip,
    smsConsent: input.consent,
  }

  return db.transaction(async (tx) => {
    const existing = input.token
      ? await queries.findOpenDraft(tenant.id, input.token, tx)
      : undefined
    const token = existing?.token ?? randomBytes(32).toString('hex')

    if (existing) {
      await queries.updateDraft(tenant.id, existing.id, contact, tx)
    } else {
      const draft = await queries.insertDraft(tenant.id, { ...contact, token }, tx)
      await audit.insertHomeownerAction(
        tenant.id,
        {
          action: 'booking_draft.created',
          entityType: 'booking_draft',
          entityId: draft.id,
          data: { zip: input.zip, consent: input.consent },
        },
        tx,
      )
    }

    if (input.consent) {
      await recordConsent(tenant.id, { phone: input.phone, granted: true, ip }, tx)
    } else if (existing?.smsConsent) {
      // They had ticked the box and now unticked it: take the consent back for that number.
      await recordConsent(tenant.id, { phone: existing.phone, granted: false, ip }, tx)
    }
    return { token }
  })
}

// After each later step: replaces the draft's answers.
export async function saveDraftAnswers(tenantId: string, token: string, answers: DraftAnswers) {
  const draft = await queries.findOpenDraft(tenantId, token)
  if (!draft) throw new HttpError(404, 'not_found', DRAFT_GONE)
  await queries.updateDraft(tenantId, draft.id, { answers })
}

// What the wizard needs to pick a draft up again.
export async function getDraft(tenantId: string, token: string) {
  const draft = await queries.findOpenDraft(tenantId, token)
  if (!draft) throw new HttpError(404, 'not_found', DRAFT_GONE)
  return {
    name: draft.name,
    phone: draft.phone,
    zip: draft.zip,
    consent: draft.smsConsent,
    answers: draft.answers,
  }
}
```

Replace `checkServiceAndZip` with these two functions (the ZIP check is now shared):

```ts
async function checkServiceAndZip(tenantId: string, serviceId: string, zip: string, tx: Db) {
  if (!(await booking.findActiveService(tenantId, serviceId, tx))) {
    throw new HttpError(404, 'not_found', SERVICE_GONE)
  }
  await checkZipServed(tenantId, zip, tx)
}

async function checkZipServed(tenantId: string, zip: string, tx: Db = db) {
  if (!(await zipIsServed(tenantId, zip, tx))) {
    throw new HttpError(422, 'outside_area', `We don’t serve ZIP code ${zip} yet.`)
  }
}
```

Add at the bottom of the file:

```ts
// The consent wording covers texts and calls, so one row is written for each, as proof.
async function recordConsent(
  tenantId: string,
  values: { phone: string; granted: boolean; ip: string | null; jobId?: string },
  tx: Db,
) {
  for (const channel of ['sms', 'voice'] as const) {
    await booking.insertConsent(
      tenantId,
      {
        contact: values.phone,
        channel,
        granted: values.granted,
        source: 'booking_form',
        wording: CONSENT_WORDING,
        jobId: values.jobId,
        ip: values.ip,
      },
      tx,
    )
  }
}
```

In `bookVisit`, replace the whole `if (input.consent) { for (const channel of ...) { ... } }` block with:

```ts
    if (input.consent) {
      await recordConsent(tenant.id, { phone: input.phone, granted: true, ip, jobId: job.id }, tx)
    }
    // The booking this draft was for is made. An unknown token is ignored: a draft must never
    // stop a booking.
    const draft = input.draftToken
      ? await queries.findOpenDraft(tenant.id, input.draftToken, tx)
      : undefined
    if (draft) await queries.markDraftBooked(tenant.id, draft.id, job.id, tx)
```

- [ ] **Step 8: Add the routes**

In `online-booking.routes.ts`, change the schemas import:

```ts
import {
  BookingInput,
  CallbackInput,
  DraftAnswersInput,
  DraftInput,
  WaitlistInput,
  ZipParams,
} from './online-booking.schemas.ts'
```

Replace the `formLimit` constant and its comment with:

```ts
// Anyone can post these forms, so one address gets a limited number of tries.
function limitTries(limit: number) {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, _res, next) =>
      next(new HttpError(429, 'rate_limited', 'Too many tries. Wait 15 minutes and try again.')),
  })
}
const formLimit = limitTries(60)
// The wizard saves its draft in the background on every step, so drafts get their own, larger
// count. They never use up the tries of the forms a homeowner sends by hand.
const draftLimit = limitTries(240)
```

Add before the `/online-booking/bookings` route:

```ts
onlineBookingRoutes.post('/online-booking/drafts', draftLimit, tenantFromHost, async (req, res) => {
  const input = DraftInput.parse(req.body)
  res.status(201).json(await onlineBooking.saveDraftContact(req.tenant!, input, req.ip ?? null))
})

onlineBookingRoutes.get(
  '/online-booking/drafts/:token',
  draftLimit,
  tenantFromHost,
  async (req, res) => {
    res.json(await onlineBooking.getDraft(req.tenant!.id, String(req.params.token)))
  },
)

onlineBookingRoutes.patch(
  '/online-booking/drafts/:token',
  draftLimit,
  tenantFromHost,
  async (req, res) => {
    const { answers } = DraftAnswersInput.parse(req.body)
    await onlineBooking.saveDraftAnswers(req.tenant!.id, String(req.params.token), answers)
    res.json({ ok: true })
  },
)
```

- [ ] **Step 9: Run the tests to see them pass**

Run: `npx biome check --write src/db/schema.ts src/modules/online-booking && npx tsc --noEmit && npx vitest run src/modules/online-booking`
Expected: no type errors; `booking-drafts.test.ts` 9 tests pass and `online-booking.test.ts` 24 tests still pass.

- [ ] **Step 10: Checkpoint**

Do not commit (see Global Constraints). Report the test counts.

---

### Task 2: The temporary `sendText()` and the recovery job

**Files:**
- Create: `relay-api/src/modules/messaging/sms.ts`
- Modify: `relay-api/src/modules/online-booking/online-booking.queries.ts`
- Modify: `relay-api/src/modules/online-booking/online-booking.service.ts`
- Modify: `relay-api/src/jobs/index.ts`
- Test: `relay-api/src/modules/online-booking/booking-drafts.test.ts`

**Interfaces:**
- Consumes (from Task 1): the `bookingDrafts` table; the test file `booking-drafts.test.ts` with its `createServingShop` helper.
- Produces:
  - `sendText(tenantId: string, text: { contact: string; kind: (typeof MESSAGE_KINDS)[number]; body: string }, tx?: Db): Promise<void>`
  - `sendRecoveryTexts(): Promise<number>` (how many drafts were texted)
  - queries `listDraftsToRecover(quietSince: Date, startedAfter: Date)`, `markDraftTexted(tenantId, draftId, tx)`

- [ ] **Step 1: Write the failing tests**

In `booking-drafts.test.ts`, change two imports:

```ts
import { createJob, createShop, resetDb, type Shop, TUESDAY } from '../../../test/helpers.ts'
```

```ts
import {
  auditEvents,
  bookingDrafts,
  consentEvents,
  jobs,
  messages,
  serviceAreaZips,
} from '../../db/schema.ts'
import { CONSENT_WORDING, sendRecoveryTexts } from './online-booking.service.ts'
```

Add at the bottom of the file:

```ts
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000)

// A draft straight in the database: consent given, quiet for 90 minutes, begun 2 hours ago.
// That is one the recovery job should text.
async function insertDraft(
  shop: Shop,
  token: string,
  overrides: Partial<typeof bookingDrafts.$inferInsert> = {},
) {
  await db.insert(bookingDrafts).values({
    tenantId: shop.tenant.id,
    token,
    name: 'Sam Reed',
    phone: '+14805550199',
    zip: '85201',
    smsConsent: true,
    lastActivityAt: minutesAgo(90),
    createdAt: minutesAgo(120),
    ...overrides,
  })
}

describe('sendRecoveryTexts', () => {
  it('saves one text with a link back, and never a second one', async () => {
    const shop = await createServingShop()
    await insertDraft(shop, 'token-1')

    expect(await sendRecoveryTexts()).toBe(1)

    const saved = await db.select().from(messages)
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({
      tenantId: shop.tenant.id,
      channel: 'sms',
      direction: 'outbound',
      kind: 'abandoned_booking',
      status: 'queued',
      contact: '+14805550199',
    })
    expect(saved[0].body).toContain('desert HVAC')
    expect(saved[0].body).toContain('https://desert.localhost/?resume=token-1')
    const [draft] = await db.select().from(bookingDrafts)
    expect(draft.recoveryTextedAt).toBeInstanceOf(Date)

    expect(await sendRecoveryTexts()).toBe(0)
    expect(await db.select().from(messages)).toHaveLength(1)
  })

  it('leaves alone every draft that must not be texted', async () => {
    const shop = await createServingShop()
    const job = await createJob(shop) // made just now, for the customer with phone +16025550111

    await insertDraft(shop, 'no-consent', { smsConsent: false })
    await insertDraft(shop, 'still-active', { lastActivityAt: minutesAgo(10) })
    await insertDraft(shop, 'too-old', { createdAt: minutesAgo(25 * 60) })
    await insertDraft(shop, 'booked', { bookedJobId: job.id })
    await insertDraft(shop, 'booked-by-phone', { phone: '+16025550111' })

    expect(await sendRecoveryTexts()).toBe(0)
    expect(await db.select().from(messages)).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run src/modules/online-booking/booking-drafts.test.ts`
Expected: FAIL. `sendRecoveryTexts` is not exported from `online-booking.service.ts`.

- [ ] **Step 3: Write the temporary `sendText()`**

Create `src/modules/messaging/sms.ts`:

```ts
import { type Db, db } from '../../db/client.ts'
import { type MESSAGE_KINDS, messages } from '../../db/schema.ts'
import { logger } from '../../lib/logger.ts'

// TEMPORARY: this does not send anything. It saves the text as 'queued' and logs that it did,
// so the rest of the app can be built and tested. Before putting a real provider here, read
// docs/real-texting-todo.md: the consent check, STOP replies and quiet hours all belong in
// this function.
export async function sendText(
  tenantId: string,
  text: { contact: string; kind: (typeof MESSAGE_KINDS)[number]; body: string },
  tx: Db = db,
) {
  const [message] = await tx
    .insert(messages)
    .values({ tenantId, channel: 'sms', direction: 'outbound', status: 'queued', ...text })
    .returning({ id: messages.id })
  logger.info(
    { tenantId, messageId: message.id, kind: text.kind },
    'Text saved, not sent: real texting isn’t built yet',
  )
}
```

- [ ] **Step 4: Add the queries**

In `online-booking.queries.ts`, change the first import to add `gt`, and add `customers` and `tenants` to the schema import:

```ts
import { and, asc, eq, gt, isNull, lt, sql } from 'drizzle-orm'
import { type Db, db } from '../../db/client.ts'
import {
  bookingDrafts,
  callbackRequests,
  customers,
  jobs,
  services,
  tenants,
  waitlistEntries,
} from '../../db/schema.ts'
```

Change the comment at the top of the file to:

```ts
// Tenant-scoped: every query takes tenantId first, except the two system jobs' queries
// (expireHolds and listDraftsToRecover), which work across contractors.
```

Add after `markDraftBooked`:

```ts
// Every contractor's drafts that are due their one recovery text: consent given, nothing from
// the homeowner since `quietSince`, begun after `startedAfter`, not booked, not texted yet, and
// no job made for that phone since the draft began (they may have called the office instead).
export function listDraftsToRecover(quietSince: Date, startedAfter: Date) {
  return db
    .select({
      id: bookingDrafts.id,
      tenantId: bookingDrafts.tenantId,
      token: bookingDrafts.token,
      phone: bookingDrafts.phone,
      tenantName: tenants.name,
      slug: tenants.slug,
      customDomain: tenants.customDomain,
      customDomainVerifiedAt: tenants.customDomainVerifiedAt,
    })
    .from(bookingDrafts)
    .innerJoin(tenants, eq(tenants.id, bookingDrafts.tenantId))
    .where(
      and(
        eq(bookingDrafts.smsConsent, true),
        isNull(bookingDrafts.bookedJobId),
        isNull(bookingDrafts.recoveryTextedAt),
        lt(bookingDrafts.lastActivityAt, quietSince),
        gt(bookingDrafts.createdAt, startedAfter),
        sql`not exists (
          select 1 from ${jobs}
          join ${customers} on ${customers.id} = ${jobs.customerId}
          where ${jobs.tenantId} = ${bookingDrafts.tenantId}
            and ${customers.phone} = ${bookingDrafts.phone}
            and ${jobs.createdAt} > ${bookingDrafts.createdAt}
        )`,
      ),
    )
}

export async function markDraftTexted(tenantId: string, draftId: string, tx: Db) {
  await tx
    .update(bookingDrafts)
    .set({ recoveryTextedAt: new Date() })
    .where(and(eq(bookingDrafts.tenantId, tenantId), eq(bookingDrafts.id, draftId)))
}
```

- [ ] **Step 5: Add the service**

In `online-booking.service.ts`, add to the imports:

```ts
import { env } from '../../config/env.ts'
import { sendText } from '../messaging/sms.ts'
```

Add after `DAYS_AHEAD`:

```ts
// Recovery text: sent once a draft has been quiet this long, and never for one begun longer
// ago than the cutoff. Still to decide: whether contractors set these themselves.
const RECOVERY_WAIT_MINUTES = 60
const RECOVERY_CUTOFF_HOURS = 24
```

Add after `expireHolds`:

```ts
// Run every 5 minutes by the 'booking-recovery' job: homeowners who agreed to texts and stopped
// partway get one text with a link back to their draft. Returns how many were texted.
export async function sendRecoveryTexts() {
  const now = Date.now()
  const drafts = await queries.listDraftsToRecover(
    new Date(now - RECOVERY_WAIT_MINUTES * 60_000),
    new Date(now - RECOVERY_CUTOFF_HOURS * 3_600_000),
  )
  for (const draft of drafts) {
    // Together, so a draft is never marked without its text, and never texted twice.
    await db.transaction(async (tx) => {
      await sendText(
        draft.tenantId,
        {
          contact: draft.phone,
          kind: 'abandoned_booking',
          body: `${draft.tenantName}: you started booking a visit. Finish here: ${bookingLink(draft, draft.token)} Reply STOP to opt out.`,
        },
        tx,
      )
      await queries.markDraftTexted(draft.tenantId, draft.id, tx)
    })
  }
  return drafts.length
}

// The address of a contractor's booking page that opens a draft: their own domain once it is
// verified, else their subdomain. Always https with no port, which is wrong on a developer's
// machine; fine while texts are only saved (docs/real-texting-todo.md).
function bookingLink(
  tenant: { slug: string; customDomain: string | null; customDomainVerifiedAt: Date | null },
  token: string,
) {
  const host =
    tenant.customDomain && tenant.customDomainVerifiedAt
      ? tenant.customDomain
      : `${tenant.slug}.${env.APP_DOMAIN}`
  return `https://${host}/?resume=${token}`
}
```

- [ ] **Step 6: Register the job**

In `src/jobs/index.ts`, add inside `startJobs`, after the `hold-expiry` registration:

```ts
  // Every 5 minutes: homeowners who stopped partway through booking get one text to finish.
  await register('booking-recovery', { cron: '*/5 * * * *' }, async () => {
    const texted = await onlineBooking.sendRecoveryTexts()
    if (texted > 0) logger.info({ texted }, 'Booking recovery texts saved')
  })
```

- [ ] **Step 7: Run the tests to see them pass**

Run: `npx biome check --write src/modules/online-booking src/modules/messaging src/jobs/index.ts && npx tsc --noEmit && npx vitest run`
Expected: no type errors. All test files pass: 170 tests from before plus 11 in `booking-drafts.test.ts` = 181.

- [ ] **Step 8: Checkpoint**

Do not commit. Report the test counts.

---

### Task 3: The contact step, saving and resuming in the wizard

**Files:** (all in `relay-web/src/features/booking/`)
- Modify: `steps.ts`, `steps.test.ts`
- Create: `draft-token.ts`, `draft-token.test.ts`
- Modify: `api.ts`
- Create: `contact-step.tsx`
- Modify: `details-step.tsx`, `booking-progress.tsx`, `time-step.tsx`, `booking-flow.tsx`

**Interfaces:**
- Consumes (from Task 1): `POST /online-booking/drafts` → `{ token }`; `GET /online-booking/drafts/:token` → `{ name, phone, zip, consent, answers }`; `PATCH /online-booking/drafts/:token` → `{ ok }`; `draftToken` on the booking.
- Produces:
  - `steps.ts`: `STEPS` with `'contact'` third; `Answers` with `name`, `phone`, `textConsent`; `DraftAnswers`; `draftAnswers(answers: Answers): DraftAnswers`; `answersFromDraft(draft: Draft, serviceIds: string[]): Answers`.
  - `draft-token.ts`: `readDraftToken(): string`, `storeDraftToken(token: string): void` (an empty string forgets it).
  - `api.ts`: `Draft` type; `useDraft(token: string)` (data is `Draft | null`); `useSaveContact()`; `useSaveDraftAnswers()`.
  - `details-step.tsx`: `NO_DETAILS`, `Details` (replace `NO_CONTACT`, `Contact`); props `details`, `onDetailsChange`, `draftToken`; no `consentWording`.
  - `booking-flow.tsx`: `BookingFlow` (unchanged export) and a private `BookingWizard` with state `draftToken`. Task 4 adds to it.

- [ ] **Step 1: Write the failing tests for the steps**

Replace `steps.test.ts` with:

```ts
import { expect, it } from 'vitest'
import { type Answers, answersFromDraft, draftAnswers, NO_ANSWERS, stepToShow } from './steps'

const UP_TO_ZIP: Answers = { ...NO_ANSWERS, serviceId: 'service-1', zip: '85004' }
const UP_TO_CONTACT: Answers = { ...UP_TO_ZIP, name: 'Sam Reed', phone: '(480) 555-0199' }
const UP_TO_TIME: Answers = {
  ...UP_TO_CONTACT,
  problem: 'No cooling',
  systemType: 'central_ac',
  date: '2030-01-08',
  windowId: 'window-1',
  timeLabel: 'Tue, Jan 8, 8 AM–12 PM',
}

it('starts at the first step', () => {
  expect(stepToShow(null, NO_ANSWERS)).toBe('service')
  expect(stepToShow('nonsense', NO_ANSWERS)).toBe('service')
})

it('opens the requested step once every step before it is answered', () => {
  expect(stepToShow('zip', { ...NO_ANSWERS, serviceId: 'service-1' })).toBe('zip')
  expect(stepToShow('contact', UP_TO_ZIP)).toBe('contact')
  expect(stepToShow('problem', UP_TO_CONTACT)).toBe('problem')
  expect(stepToShow('details', UP_TO_TIME)).toBe('details')
})

it('sends a refresh or a copied link back to the first unanswered step', () => {
  expect(stepToShow('details', NO_ANSWERS)).toBe('service')
  expect(stepToShow('time', UP_TO_ZIP)).toBe('contact')
  expect(stepToShow('time', UP_TO_CONTACT)).toBe('problem')
  expect(stepToShow('details', { ...UP_TO_TIME, windowId: '' })).toBe('time')
})

it('lets the homeowner go back to an answered step', () => {
  expect(stepToShow('service', UP_TO_TIME)).toBe('service')
  expect(stepToShow('zip', UP_TO_TIME)).toBe('zip')
})

it('keeps only the answered parts in a draft, and never the arrival window', () => {
  expect(draftAnswers(UP_TO_CONTACT)).toEqual({
    serviceId: 'service-1',
    problem: undefined,
    systemType: undefined,
    vulnerableOccupant: false,
    priorityService: false,
  })
  expect(draftAnswers(UP_TO_TIME)).toEqual({
    serviceId: 'service-1',
    problem: 'No cooling',
    systemType: 'central_ac',
    vulnerableOccupant: false,
    priorityService: false,
  })
})

it('starts the wizard from a saved draft', () => {
  const draft = {
    name: 'Sam Reed',
    phone: '+14805550199',
    zip: '85004',
    consent: true,
    answers: { serviceId: 'service-1', problem: 'No cooling', systemType: 'central_ac' as const },
  }

  const answers = answersFromDraft(draft, ['service-1'])
  expect(answers).toEqual({
    ...NO_ANSWERS,
    serviceId: 'service-1',
    zip: '85004',
    name: 'Sam Reed',
    phone: '+14805550199',
    textConsent: true,
    problem: 'No cooling',
    systemType: 'central_ac',
  })
  // Everything but the arrival window is answered, so that is where they land.
  expect(stepToShow('details', answers)).toBe('time')
})

it('drops a saved service the contractor no longer offers', () => {
  const draft = {
    name: 'Sam Reed',
    phone: '+14805550199',
    zip: '85004',
    consent: false,
    answers: { serviceId: 'gone' },
  }

  expect(answersFromDraft(draft, ['service-1']).serviceId).toBe('')
  expect(stepToShow('details', answersFromDraft(draft, ['service-1']))).toBe('service')
})
```

Create `draft-token.test.ts`:

```ts
import { afterEach, expect, it, vi } from 'vitest'
import { readDraftToken, storeDraftToken } from './draft-token'

afterEach(() => {
  vi.unstubAllGlobals()
})

// A stand-in for the browser's localStorage.
function fakeStorage() {
  const items = new Map<string, string>()
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  }
}

it('keeps the token and forgets it again', () => {
  vi.stubGlobal('localStorage', fakeStorage())

  expect(readDraftToken()).toBe('')
  storeDraftToken('abc')
  expect(readDraftToken()).toBe('abc')
  storeDraftToken('')
  expect(readDraftToken()).toBe('')
})

it('acts as if there is no draft when storage is blocked', () => {
  const blocked = () => {
    throw new Error('blocked')
  }
  vi.stubGlobal('localStorage', { getItem: blocked, setItem: blocked, removeItem: blocked })

  expect(() => storeDraftToken('abc')).not.toThrow()
  expect(readDraftToken()).toBe('')
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run (in `relay-web`): `npx vitest run src/features/booking`
Expected: FAIL. `./draft-token` does not exist, and `steps.ts` has no `answersFromDraft`, `draftAnswers` or `contact` step.

- [ ] **Step 3: Rewrite `steps.ts`**

```ts
import type { SystemType } from '@/features/dispatch/api'
import type { Draft } from './api'

// The booking wizard's screens, in order.
export const STEPS = ['service', 'zip', 'contact', 'problem', 'time', 'details'] as const
export type Step = (typeof STEPS)[number]

export const STEP_TITLES: Record<Step, string> = {
  service: 'What do you need?',
  zip: 'Where are you?',
  contact: 'Where should we reach you?',
  problem: 'What’s going on?',
  time: 'Pick an arrival window',
  details: 'Your details',
}

// What the homeowner has answered in steps 1 to 5. An empty value means "not answered yet".
// The last step's own fields (email, address) stay in that step and go straight to the API.
export type Answers = {
  serviceId: string
  zip: string // set only once the ZIP code is in the service area
  name: string // set only once the draft is saved
  phone: string
  textConsent: boolean // the optional "text me" box on the contact step
  problem: string
  systemType: SystemType | ''
  vulnerableOccupant: boolean
  priorityService: boolean
  date: string // '2030-01-08'
  windowId: string
  timeLabel: string // 'Tue, Jan 8, 8 AM–12 PM'
}

export const NO_ANSWERS: Answers = {
  serviceId: '',
  zip: '',
  name: '',
  phone: '',
  textConsent: false,
  problem: '',
  systemType: '',
  vulnerableOccupant: false,
  priorityService: false,
  date: '',
  windowId: '',
  timeLabel: '',
}

function isAnswered(step: Step, answers: Answers): boolean {
  if (step === 'service') return answers.serviceId !== ''
  if (step === 'zip') return answers.zip !== ''
  if (step === 'contact') return answers.name !== '' && answers.phone !== ''
  if (step === 'problem') return answers.problem !== '' && answers.systemType !== ''
  if (step === 'time') return answers.windowId !== ''
  return false // 'details' is the last step: it is never behind the homeowner
}

// Which step to show for the `?step=` in the address bar. A step only opens when every step
// before it is answered, so the homeowner lands on the first unanswered step instead of a
// half-empty later one.
export function stepToShow(requested: string | null, answers: Answers): Step {
  const firstUnanswered = STEPS.find((step) => !isAnswered(step, answers)) ?? 'details'
  const wanted = STEPS.find((step) => step === requested) ?? 'service'
  return STEPS.indexOf(wanted) <= STEPS.indexOf(firstUnanswered) ? wanted : firstUnanswered
}

// The part of the answers the API keeps in a draft. The arrival window is left out on purpose:
// open windows change, so a homeowner who comes back picks one again.
export type DraftAnswers = Draft['answers']

export function draftAnswers(answers: Answers): DraftAnswers {
  return {
    serviceId: answers.serviceId || undefined,
    problem: answers.problem || undefined,
    systemType: answers.systemType || undefined,
    vulnerableOccupant: answers.vulnerableOccupant,
    priorityService: answers.priorityService,
  }
}

// The wizard's starting answers for a homeowner who comes back to a saved draft. A service the
// contractor stopped offering is dropped, so they pick one again.
export function answersFromDraft(draft: Draft, serviceIds: string[]): Answers {
  const saved = draft.answers
  return {
    ...NO_ANSWERS,
    serviceId: saved.serviceId && serviceIds.includes(saved.serviceId) ? saved.serviceId : '',
    zip: draft.zip,
    name: draft.name,
    phone: draft.phone,
    textConsent: draft.consent,
    problem: saved.problem ?? '',
    systemType: saved.systemType ?? '',
    vulnerableOccupant: saved.vulnerableOccupant ?? false,
    priorityService: saved.priorityService ?? false,
  }
}
```

- [ ] **Step 4: Create `draft-token.ts`**

```ts
// The token of this browser's unfinished booking, kept so a refresh or a later visit picks it
// up again. Storage can be blocked (private windows, site settings): then nothing is kept and
// the wizard simply starts fresh.
const KEY = 'relay.booking-draft'

export function readDraftToken(): string {
  try {
    return localStorage.getItem(KEY) ?? ''
  } catch {
    return ''
  }
}

// An empty token forgets the draft.
export function storeDraftToken(token: string) {
  try {
    if (token) localStorage.setItem(KEY, token)
    else localStorage.removeItem(KEY)
  } catch {
    // Storage is blocked: nothing to keep.
  }
}
```

- [ ] **Step 5: Add the draft calls to `api.ts`**

Change the imports at the top:

```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { PRICE_TYPES } from '@/features/catalog/prices'
import { SYSTEM_TYPES, type SystemType } from '@/features/dispatch/api'
import { ApiError, api } from '@/lib/api'
import { storeDraftToken } from './draft-token'
```

Add after the `Booked` schema:

```ts
const DraftSaved = z.object({ token: z.string() })

// An unfinished booking the API kept: who started it and what they had answered.
const Draft = z.object({
  name: z.string(),
  phone: z.string(), // '+14805550199'
  zip: z.string(),
  consent: z.boolean(),
  answers: z.object({
    serviceId: z.string().optional(),
    problem: z.string().optional(),
    systemType: z.enum(SYSTEM_TYPES).optional(),
    vulnerableOccupant: z.boolean().optional(),
    priorityService: z.boolean().optional(),
  }),
})
export type Draft = z.infer<typeof Draft>

// `token` is the draft this browser already has, or '' for a new one.
export type ContactInput = {
  name: string
  phone: string
  zip: string
  consent: boolean
  token: string
}
```

In `BookingInput`, add one line after `consent: boolean`:

```ts
  consent: boolean
  draftToken?: string // the draft this booking finishes
```

Add after `useRequestCallback`:

```ts
// On load: the draft to pick up again, or null when there is none to use. Loaded once (it only
// gives the wizard its starting answers), so it never goes stale.
export function useDraft(token: string) {
  return useQuery({
    queryKey: ['online-booking', 'draft', token],
    enabled: token !== '',
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async () => {
      try {
        const draft = await api.get(`/online-booking/drafts/${token}`, Draft)
        storeDraftToken(token) // a link from a text lands here too: keep it for a refresh
        return draft
      } catch (error) {
        // Already booked, or not this contractor's: forget it. Anything else (offline, say)
        // keeps the token for next time. Either way the wizard starts fresh.
        if (error instanceof ApiError && error.status === 404) storeDraftToken('')
        else console.error('Loading the saved booking failed', error)
        return null
      }
    },
  })
}

// Step 3: saves who is booking as a draft, so an unfinished booking isn't lost.
export function useSaveContact() {
  return useMutation({
    mutationFn: ({ token, ...contact }: ContactInput) =>
      api.post('/online-booking/drafts', { ...contact, token: token || undefined }, DraftSaved),
  })
}

// After each later step: keeps the draft's answers up to date. Nobody waits for it and a
// failure is ignored: saving must never get in the way of booking.
export function useSaveDraftAnswers() {
  return useMutation({
    mutationFn: ({ token, answers }: { token: string; answers: Draft['answers'] }) =>
      api.patch(`/online-booking/drafts/${token}`, { answers }, Sent),
  })
}
```

- [ ] **Step 6: Create `contact-step.tsx`**

```tsx
import { Phone } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { toast } from 'sonner'
import { CheckboxField } from '@/components/checkbox-field'
import { Field, type FieldErrors } from '@/components/form-field'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ApiError } from '@/lib/api'
import { errorMessage } from '@/lib/errors'
import { useSaveContact } from './api'
import { Panel } from './booking-ui'
import type { Answers } from './steps'

type ContactAnswers = Pick<Answers, 'name' | 'phone' | 'textConsent'>

// Step 3: who is booking. Sending it saves a draft, so a homeowner who stops here or later can
// pick the booking up again. The "text me" box is optional: booking never depends on it.
// `draftToken` is the draft this browser already has ('' for none); `onDone` gets the token of
// the draft that was saved.
export function ContactStep({
  answers,
  draftToken,
  consentWording,
  onDone,
}: {
  answers: Answers
  draftToken: string
  consentWording: string
  onDone: (contact: ContactAnswers, token: string) => void
}) {
  const [name, setName] = useState(answers.name)
  const [phone, setPhone] = useState(answers.phone)
  const [textConsent, setTextConsent] = useState(answers.textConsent)
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const save = useSaveContact()

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    save.mutate(
      { name, phone, zip: answers.zip, consent: textConsent, token: draftToken },
      {
        onSuccess: ({ token }) =>
          onDone({ name: name.trim(), phone: phone.trim(), textConsent }, token),
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
      <Panel className="space-y-4">
        <div className="flex items-center gap-3">
          <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Phone className="size-6" />
          </span>
          <p className="text-sm text-muted-foreground">
            So we can reach you about your visit. Your answers are saved from here, so you can
            finish later if you have to stop.
          </p>
        </div>
        <Field id="booking-name" label="Name" errors={fieldErrors.name}>
          <Input
            id="booking-name"
            className="h-11"
            autoComplete="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field id="booking-phone" label="Mobile phone" errors={fieldErrors.phone}>
          <Input
            id="booking-phone"
            className="h-11"
            type="tel"
            autoComplete="tel"
            placeholder="(480) 555-0199"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
          />
        </Field>
      </Panel>

      <Panel>
        <CheckboxField
          checked={textConsent}
          onChange={setTextConsent}
          label={consentWording}
          hint="Optional. You can book without it."
        />
      </Panel>

      <Button type="submit" className="h-12 w-full text-base" disabled={save.isPending}>
        {save.isPending ? 'Saving…' : 'Continue'}
      </Button>
    </form>
  )
}
```

- [ ] **Step 7: Rewrite `details-step.tsx`**

Name, phone and the consent box moved to the contact step. Replace the file with:

```tsx
import { Mail, MapPin } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { toast } from 'sonner'
import { Field, type FieldErrors } from '@/components/form-field'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ApiError } from '@/lib/api'
import { errorMessage } from '@/lib/errors'
import { type Booked, type BookingService, useBookVisit } from './api'
import { BookingSummary } from './booking-summary'
import { Panel } from './booking-ui'
import type { Answers } from './steps'

export const NO_DETAILS = {
  email: '',
  street: '',
  unit: '',
  city: '',
  state: '',
}
export type Details = typeof NO_DETAILS

// The API's reasons for "that window can't be taken anymore".
const WINDOW_GONE = ['window_full', 'window_started', 'window_not_offered', 'past_date']

// Step 6: where the visit is. Sending it books the arrival window; the homeowner pays at the
// visit. `priorityFeeCents` is 0 unless the homeowner chose priority service. `details` is kept
// by the wizard, so it survives a trip back to step 5 when the window is gone. `draftToken` is
// the draft this booking finishes ('' for none).
export function DetailsStep({
  answers,
  service,
  priorityFeeCents,
  details,
  draftToken,
  onDetailsChange,
  onBooked,
  onWindowGone,
}: {
  answers: Answers
  service: BookingService
  priorityFeeCents: number
  details: Details
  draftToken: string
  onDetailsChange: (details: Details) => void
  onBooked: (booked: Booked) => void
  onWindowGone: () => void
}) {
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const book = useBookVisit()

  const set = (key: keyof Details) => (event: { target: { value: string } }) =>
    onDetailsChange({ ...details, [key]: event.target.value })

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    book.mutate(
      {
        serviceId: answers.serviceId,
        date: answers.date,
        windowId: answers.windowId,
        problem: answers.problem,
        systemType: answers.systemType,
        vulnerableOccupant: answers.vulnerableOccupant,
        priorityService: answers.priorityService,
        name: answers.name,
        phone: answers.phone,
        ...details,
        zip: answers.zip,
        consent: answers.textConsent,
        draftToken: draftToken || undefined,
      },
      {
        onSuccess: onBooked,
        onError: (error) => {
          if (error instanceof ApiError && error.code === 'validation_failed') {
            setFieldErrors(error.details)
            return
          }
          setFieldErrors({})
          toast.error(errorMessage(error))
          // The window filled up or started while they typed: back to step 5 for another one.
          if (error instanceof ApiError && WINDOW_GONE.includes(error.code)) onWindowGone()
        },
      },
    )
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <BookingSummary
        service={service}
        timeLabel={answers.timeLabel}
        priorityFeeCents={priorityFeeCents}
      />

      <Panel className="space-y-4">
        <h3 className="flex items-center gap-2 font-semibold">
          <MapPin className="size-4 text-primary" />
          Where we’re going
        </h3>
        <div className="grid grid-cols-[1fr_6rem] gap-3">
          <Field id="booking-street" label="Street address" errors={fieldErrors.street}>
            <Input
              id="booking-street"
              className="h-11"
              autoComplete="address-line1"
              value={details.street}
              onChange={set('street')}
            />
          </Field>
          <Field id="booking-unit" label="Unit" errors={fieldErrors.unit}>
            <Input
              id="booking-unit"
              className="h-11"
              autoComplete="address-line2"
              value={details.unit}
              onChange={set('unit')}
            />
          </Field>
        </div>
        <div className="grid grid-cols-[1fr_4.5rem_6rem] gap-3">
          <Field id="booking-city" label="City" errors={fieldErrors.city}>
            <Input
              id="booking-city"
              className="h-11"
              autoComplete="address-level2"
              value={details.city}
              onChange={set('city')}
            />
          </Field>
          <Field id="booking-state" label="State" errors={fieldErrors.state}>
            <Input
              id="booking-state"
              className="h-11"
              autoComplete="address-level1"
              maxLength={2}
              placeholder="AZ"
              value={details.state}
              onChange={set('state')}
            />
          </Field>
          {/* Checked against the service area in step 2, so it can only change there. */}
          <Field id="booking-zip-fixed" label="ZIP" errors={fieldErrors.zip}>
            <Input id="booking-zip-fixed" className="h-11" value={answers.zip} disabled />
          </Field>
        </div>
      </Panel>

      <Panel className="space-y-4">
        <h3 className="flex items-center gap-2 font-semibold">
          <Mail className="size-4 text-primary" />
          Email
        </h3>
        <Field id="booking-email" label="Email (optional)" errors={fieldErrors.email}>
          <Input
            id="booking-email"
            className="h-11"
            type="email"
            autoComplete="email"
            value={details.email}
            onChange={set('email')}
          />
        </Field>
      </Panel>

      {/* Sticks to the bottom of the screen, so the button stays in reach on a long form. */}
      <div className="sticky bottom-0 -mx-4 bg-card p-4 shadow-[0_-4px_16px_rgb(0_0_0/0.06)] sm:mx-0 sm:rounded-2xl">
        <Button type="submit" className="h-12 w-full text-base" disabled={book.isPending}>
          {book.isPending ? 'Booking your visit…' : 'Book my visit'}
        </Button>
      </div>
    </form>
  )
}
```

The email panel's heading is the plain word "Email" on purpose: no confirmation email is sent today, so the page must not suggest one.

- [ ] **Step 8: Add the sixth dot to `booking-progress.tsx`**

Replace the `LABELS` constant and the comment above the component:

```ts
const LABELS: Record<Step, string> = {
  service: 'Service',
  zip: 'Area',
  contact: 'Contact',
  problem: 'Problem',
  time: 'Time',
  details: 'Details',
}

// The steps as connected dots. Finished steps show a check and can be tapped to go back.
```

- [ ] **Step 9: Start the waitlist form with the known name and phone**

In `time-step.tsx`, inside `WaitlistForm`, the homeowner already gave both on the contact step. Replace:

```ts
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
```

with:

```ts
  // Already given on the contact step; they can still change them here.
  const [name, setName] = useState(answers.name)
  const [phone, setPhone] = useState(answers.phone)
```

- [ ] **Step 10: Rewrite `booking-flow.tsx`**

```tsx
import { ArrowLeft, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { useSearchParams } from 'react-router'
import { Button } from '@/components/ui/button'
import { errorMessage } from '@/lib/errors'
import {
  type Booked,
  type BookingOptions,
  type Draft,
  useBookingOptions,
  useDraft,
  useSaveDraftAnswers,
} from './api'
import { BookedScreen } from './booked-screen'
import { BookingProgress } from './booking-progress'
import { Panel } from './booking-ui'
import { ContactStep } from './contact-step'
import { DetailsStep, NO_DETAILS } from './details-step'
import { readDraftToken, storeDraftToken } from './draft-token'
import { ProblemStep } from './problem-step'
import { ServiceStep } from './service-step'
import {
  type Answers,
  answersFromDraft,
  draftAnswers,
  NO_ANSWERS,
  STEP_TITLES,
  STEPS,
  type Step,
  stepToShow,
} from './steps'
import { TimeStep } from './time-step'
import { ZipStep } from './zip-step'

// Loads what the wizard needs before it starts: the contractor's booking options and, when this
// homeowner began a booking before, their saved draft.
export function BookingFlow() {
  const [params] = useSearchParams()
  // Read once: the link from a recovery text (`?resume=`), else the draft this browser kept.
  const [resumeToken] = useState(() => params.get('resume') ?? readDraftToken())
  const options = useBookingOptions()
  const draft = useDraft(resumeToken)

  if (options.isPending || draft.isLoading) {
    return (
      <Panel className="flex items-center justify-center gap-2 py-10 text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Loading…
      </Panel>
    )
  }
  if (options.isError) {
    return (
      <Panel className="space-y-2">
        <p className="text-sm text-destructive">{errorMessage(options.error)}</p>
        <Button variant="outline" size="sm" onClick={() => options.refetch()}>
          Try again
        </Button>
      </Panel>
    )
  }

  return (
    <BookingWizard
      options={options.data}
      savedDraft={draft.data ?? null}
      savedToken={draft.data ? resumeToken : ''}
    />
  )
}

// The homeowner's booking wizard (flow A), steps 1 to 6: service, ZIP code, contact, problem,
// arrival window, details. It ends with the visit booked; the homeowner pays at the visit.
// The answers live here. The current step lives in the address bar (`?step=zip`), so the
// phone's Back button goes back one step instead of leaving the page.
// From the contact step on, the answers are also kept in a draft on the API, so a homeowner
// who stops can pick the booking up again (`savedDraft`).
function BookingWizard({
  options,
  savedDraft,
  savedToken,
}: {
  options: BookingOptions
  savedDraft: Draft | null
  savedToken: string
}) {
  const { services, priorityFeeCents, consentWording, waitlistConsentWording } = options
  const [params, setParams] = useSearchParams()
  const [answers, setAnswers] = useState<Answers>(() =>
    savedDraft
      ? answersFromDraft(
          savedDraft,
          services.map((service) => service.id),
        )
      : NO_ANSWERS,
  )
  const [draftToken, setDraftToken] = useState(savedToken) // '' until the contact step saves one
  const [details, setDetails] = useState(NO_DETAILS) // step 6's email and address
  const [booked, setBooked] = useState<Booked | null>(null)
  const saveAnswers = useSaveDraftAnswers()

  const service = services.find((candidate) => candidate.id === answers.serviceId)
  // What this homeowner pays for priority service: nothing unless they chose it.
  const chosenFeeCents = answers.priorityService ? priorityFeeCents : 0
  // A homeowner coming back to a draft has no `?step=` yet. Asking for the last step makes
  // stepToShow pick the first one they haven't answered.
  const step = stepToShow(params.get('step') ?? (savedDraft ? 'details' : null), answers)
  const stepNumber = STEPS.indexOf(step) + 1

  // Saves a step's answers and opens another step. With a draft, the answers also go to the
  // API in the background. `token` is passed by the contact step, whose new draft isn't in
  // `draftToken` yet.
  function go(to: Step, changes: Partial<Answers> = {}, token = draftToken) {
    const next = { ...answers, ...changes }
    setAnswers(next)
    setParams({ step: to })
    if (token) saveAnswers.mutate({ token, answers: draftAnswers(next) })
  }

  function contactDone(contact: Partial<Answers>, token: string) {
    setDraftToken(token)
    storeDraftToken(token)
    go('problem', contact, token)
  }

  // The draft became a booking: there is nothing left to resume.
  function bookingDone(result: Booked) {
    setBooked(result)
    setDraftToken('')
    storeDraftToken('')
  }

  // Back to step 1. The name, phone, email and address stay, so a second visit to the same
  // home doesn't need them typed again.
  function bookAgain() {
    setAnswers({
      ...NO_ANSWERS,
      name: answers.name,
      phone: answers.phone,
      textConsent: answers.textConsent,
    })
    setBooked(null)
    setParams({ step: 'service' })
  }

  if (booked && service) {
    return (
      <BookedScreen
        service={service}
        timeLabel={answers.timeLabel}
        priorityFeeCents={chosenFeeCents}
        onBookAgain={bookAgain}
      />
    )
  }

  return (
    <div className="space-y-4">
      <BookingProgress current={step} onGoTo={(to) => go(to)} />

      <h2 className="px-1 pt-2 text-xl font-semibold tracking-tight">{STEP_TITLES[step]}</h2>

      {/* `key` restarts the fade-in every time the step changes. */}
      <div
        key={step}
        className="animate-in space-y-4 duration-300 fade-in slide-in-from-right-4 motion-reduce:animate-none"
      >
        {step === 'service' && (
          <ServiceStep
            services={services}
            selectedId={answers.serviceId}
            onPick={(serviceId) => go('zip', { serviceId })}
          />
        )}
        {step === 'zip' && <ZipStep zip={answers.zip} onServed={(zip) => go('contact', { zip })} />}
        {step === 'contact' && (
          <ContactStep
            answers={answers}
            draftToken={draftToken}
            consentWording={consentWording}
            onDone={contactDone}
          />
        )}
        {step === 'problem' && (
          <ProblemStep
            answers={answers}
            priorityFeeCents={priorityFeeCents}
            onDone={(problem) => go('time', problem)}
          />
        )}
        {step === 'time' && (
          <TimeStep
            answers={answers}
            waitlistConsentWording={waitlistConsentWording}
            onPick={(time) => go('details', time)}
          />
        )}
        {step === 'details' && service && (
          <DetailsStep
            answers={answers}
            service={service}
            priorityFeeCents={chosenFeeCents}
            details={details}
            draftToken={draftToken}
            onDetailsChange={setDetails}
            onBooked={bookingDone}
            onWindowGone={() => go('time', { date: '', windowId: '', timeLabel: '' })}
          />
        )}
      </div>

      {stepNumber > 1 && (
        <Button variant="ghost" className="h-11 w-full" onClick={() => go(STEPS[stepNumber - 2])}>
          <ArrowLeft />
          Back
        </Button>
      )}
    </div>
  )
}
```

- [ ] **Step 11: Run the checks**

Run (in `relay-web`): `npx biome check --write src/features/booking && npx tsc -b && npx vitest run`
Expected: no lint or type errors. 14 test files pass. `steps.test.ts` has 7 tests and `draft-token.test.ts` has 2, so the total is 55 − 4 + 7 + 2 = 60 tests.

- [ ] **Step 12: Checkpoint**

Do not commit. Report the test counts.

---

### Task 4: The Exit button

**Files:** (in `relay-web/src/features/booking/`)
- Create: `booking-exit.tsx`
- Modify: `booking-flow.tsx`

**Interfaces:**
- Consumes (from Task 3): `BookingWizard` in `booking-flow.tsx`, its `draftToken` state; `Panel` from `booking-ui.tsx`; `Dialog*` from `@/components/ui/dialog`.
- Produces: `ExitDialog({ open, saved, onStay, onLeave })` and `LeftScreen({ saved, onReturn })`. `saved` is true when a draft exists.

The wizard has no browser tests (Vitest runs without a DOM), so this task is checked by lint, the type check, and the manual run in Task 5.

- [ ] **Step 1: Create `booking-exit.tsx`**

```tsx
import { DoorOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Panel } from './booking-ui'

// Asks before the homeowner leaves the wizard, so leaving is a choice and not an accident.
// `saved` is true once their answers are kept in a draft.
// No text is promised here on purpose: real texting isn't built yet
// (relay-api/docs/real-texting-todo.md).
export function ExitDialog({
  open,
  saved,
  onStay,
  onLeave,
}: {
  open: boolean
  saved: boolean
  onStay: () => void
  onLeave: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onStay()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Leave without booking?</DialogTitle>
          <DialogDescription>
            {saved
              ? 'Your answers are saved. Open this page again on this device to pick up where you left off.'
              : 'Nothing is saved yet, so you’d start again next time.'}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onLeave}>
            Leave
          </Button>
          <Button onClick={onStay}>Keep booking</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// Shown after the homeowner chose to leave. Nothing was booked.
export function LeftScreen({ saved, onReturn }: { saved: boolean; onReturn: () => void }) {
  return (
    <Panel className="space-y-3 text-center">
      <span className="mx-auto flex size-14 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <DoorOpen className="size-8" />
      </span>
      <h2 className="text-xl font-semibold">You can close this page</h2>
      <p className="text-sm text-muted-foreground">
        {saved
          ? 'Nothing is booked yet. Your answers are saved for when you come back.'
          : 'Nothing was booked.'}
      </p>
      <Button variant="outline" className="h-11" onClick={onReturn}>
        Back to booking
      </Button>
    </Panel>
  )
}
```

- [ ] **Step 2: Add the button and the two screens to `booking-flow.tsx`**

Change two imports:

```ts
import { ArrowLeft, Loader2, X } from 'lucide-react'
```

```ts
import { BookedScreen } from './booked-screen'
import { ExitDialog, LeftScreen } from './booking-exit'
```

In `BookingWizard`, add two lines of state after `const [booked, setBooked] = ...`:

```ts
  const [exiting, setExiting] = useState(false) // the "leave without booking?" dialog is open
  const [left, setLeft] = useState(false) // they chose to leave
```

Add after the `if (booked && service) { ... }` block:

```tsx
  if (left) return <LeftScreen saved={draftToken !== ''} onReturn={() => setLeft(false)} />
```

Replace the step title line

```tsx
      <h2 className="px-1 pt-2 text-xl font-semibold tracking-tight">{STEP_TITLES[step]}</h2>
```

with:

```tsx
      <div className="flex items-center justify-between gap-3 px-1 pt-2">
        <h2 className="text-xl font-semibold tracking-tight">{STEP_TITLES[step]}</h2>
        <Button variant="ghost" className="h-9" onClick={() => setExiting(true)}>
          <X />
          Exit
        </Button>
      </div>
```

Add just before the closing `</div>` of the wizard's returned markup (after the Back button):

```tsx
      <ExitDialog
        open={exiting}
        saved={draftToken !== ''}
        onStay={() => setExiting(false)}
        onLeave={() => {
          setExiting(false)
          setLeft(true)
        }}
      />
```

- [ ] **Step 3: Run the checks**

Run (in `relay-web`): `npx biome check --write src/features/booking && npx tsc -b && npx vitest run`
Expected: no lint or type errors; 60 tests pass.

- [ ] **Step 4: Checkpoint**

Do not commit.

---

### Task 5: Migrate the development database and check it end to end

**Files:** none changed.

This step changes the local development database (it adds one table). Nothing is deleted.

- [ ] **Step 1: Apply the migration**

Run (in `relay-api`): `npm run db:migrate`
Expected: it finishes without an error. `booking_drafts` now exists in the `relay` database.

- [ ] **Step 2: Start both apps**

`npm run dev` in `relay-api` (port 3000) and in `relay-web` (port 5173), if they aren't running. Open `http://desert.localhost:5173`.

- [ ] **Step 3: Walk through it**

Check each line and report what happened, including anything that looks off:

1. Six dots show. Service, then ZIP, then "Where should we reach you?".
2. Continue with an empty phone: a message appears under the phone field.
3. Continue with a name and phone, box unticked: it moves on to the problem step.
4. Answer the problem step, then refresh the page: the wizard opens at the arrival-window step, not at step 1.
5. Pick a window, fill the address, "Book my visit": the "You're booked" screen shows.
6. Refresh after booking: the wizard starts at step 1 (the draft is gone).
7. Start again, go past the contact step, tap Exit: the dialog says the answers are saved. "Leave" shows "You can close this page"; "Back to booking" returns to the same step.
8. Tap Exit on step 1 of a fresh wizard (private window): the dialog says nothing is saved yet.
9. At phone width (about 380px): the six dot labels fit on one row without overlapping.
10. In the database, `select name, phone, sms_consent, answers, booked_job_id from booking_drafts order by created_at desc;` shows the drafts from these steps, and the booked one has `booked_job_id` set.

- [ ] **Step 4: Report**

State which of the ten lines passed, which did not, and what was not checked.
