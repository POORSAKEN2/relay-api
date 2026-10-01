# Booking Photos Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On step 4 of the booking wizard, a homeowner who picks "Not sure" or "Other" can add up to 3 photos of their unit (optional, with a strong nudge), and the office sees them in the job drawer.

**Architecture:** Photos are shrunk in the browser and stored in Postgres (`booking_photos`), linked to the booking draft saved at step 3. A booked job finds its photos through `booking_drafts.booked_job_id`. Homeowner routes are keyed by the draft token; staff routes by job id. A daily pg-boss job deletes photos of drafts nobody booked.

**Tech Stack:** relay-api: Express 5, Drizzle ORM, PostgreSQL 18, pg-boss, Zod, Vitest + Supertest. relay-web: React 19, TanStack Query, Zod, Tailwind v4, shadcn/ui (Base UI), Vitest.

**Spec:** `relay-api/docs/superpowers/specs/2026-10-01-booking-photos-design.md`

## Global Constraints

- Two separate git repos side by side: `relay-api` and `relay-web`. Work on branch `feat/booking-photos` in both.
- Lean, plain code a junior developer can debug without AI. Match the surrounding comment style (short "why" comments above functions).
- Commit messages: lowercase conventional style like the history (`feat: …`, `docs: …`). No `Co-Authored-By` trailer.
- Run Biome only on the files you touched: `npx biome check --write <paths>`. The working copies use CRLF; Biome rewrites touched files to LF, which git normalizes.
- Limits: at most `3` photos per draft; at most `1024 * 1024` bytes each; browser shrinks to `1600` px longest side, JPEG quality `0.8`; upload rate limit `30` per 15 minutes per address; cleanup after `30` days of no activity; cron `'30 3 * * *'` (UTC).
- Exact copy:
  - `Pick a JPEG, PNG or WebP photo.` (422 `not_a_photo`)
  - `That photo is too large. Pick a smaller one.` (413 `photo_too_large`)
  - `You can add up to 3 photos.` (409 `too_many_photos`)
  - `That photo isn’t available anymore.` (404, homeowner image route)
  - `That photo isn’t on this job.` (404, staff image route)
  - `That photo link isn’t valid` (400, bad photo id)
  - Card title `Add a photo of your unit`; card text `A photo of your unit and its label helps your technician bring the right parts.`; button `Take or choose a photo`
  - Nudge `A photo really helps. Add one, or tap Continue again to skip.`
  - Upload failure `We couldn’t add this photo. You can still book without it.`; remove failure toast `We couldn’t remove that photo. Try again.`
  - Drawer alt text `Homeowner’s photo 1` (2, 3)
- Schema rules (top of `relay-api/src/db/schema.ts`): tenant tables reference parents by `(tenant_id, x_id)`; parents get `unique (tenant_id, id)`; no cascades.

## Files

relay-api:
- Modify `src/db/schema.ts`: `unique (tenant_id, id)` on `booking_drafts`; new `booking_photos` table and its two constants.
- Create `drizzle/0007_booking_photos.sql` (generated) and `drizzle/meta/0007_snapshot.json` (generated).
- Create `src/lib/send-photo.ts`: sends a stored photo with safe headers. Used by the team, online-booking and dispatch routes.
- Modify `src/modules/team/team.routes.ts`: use `sendPhoto`.
- Modify `src/modules/online-booking/online-booking.{queries,service,schemas,routes}.ts`: draft photo queries, service functions, `PhotoParams`, four routes, cleanup.
- Create `src/modules/online-booking/booking-photos.test.ts`.
- Modify `src/modules/dispatch/dispatch.{queries,service,schemas,routes}.ts` and `dispatch.test.ts`: photos in the job detail, staff image route.
- Modify `src/jobs/index.ts`: register `booking-photo-cleanup`.

relay-web:
- Create `src/features/booking/photo.ts` + `photo.test.ts`: resize math and shrinking.
- Create `src/features/booking/photo-card.tsx`: the step 4 photo card.
- Modify `src/features/booking/api.ts`: photo schema and three hooks.
- Modify `src/features/booking/problem-step.tsx`: show the card, the nudge.
- Modify `src/features/booking/booking-flow.tsx`: pass `draftToken` to `ProblemStep`.
- Modify `src/index.css`: `animate-shake`.
- Modify `src/features/dispatch/api.ts` and `job-drawer.tsx`: thumbnails.

---

### Task 1: Branches, spec and plan

**Files:**
- Commit: `relay-api/docs/superpowers/specs/2026-10-01-booking-photos-design.md`, `relay-api/docs/superpowers/plans/2026-10-01-booking-photos.md`
- Commit (relay-web, earlier uncommitted work): `src/features/booking/booking-flow.tsx`, `booking-shell.tsx`, `contact-step.tsx`, `service-step.tsx`, `src/routes/booking.tsx`

**Interfaces:**
- Produces: branch `feat/booking-photos` in both repos.

- [ ] **Step 1: Branch relay-api and commit the docs**

```bash
cd relay-api
git switch -c feat/booking-photos
git add docs/superpowers/specs/2026-10-01-booking-photos-design.md docs/superpowers/plans/2026-10-01-booking-photos.md
git commit -m "docs: add the booking photos spec and plan"
```

- [ ] **Step 2: Branch relay-web and commit the step 1 and 3 layout work already in the working copy**

That work touches `booking-flow.tsx`, which Task 5 changes too, so it gets its own commit first.

```bash
cd ../relay-web
git switch -c feat/booking-photos
git add src/features/booking/booking-flow.tsx src/features/booking/booking-shell.tsx src/features/booking/contact-step.tsx src/features/booking/service-step.tsx src/routes/booking.tsx
git commit -m "feat: match booking steps 1 and 3 to the Figma layout"
```

Expected: `git status --short` is clean in both repos.

---

### Task 2: API — table and homeowner photo routes

**Files:**
- Modify: `relay-api/src/db/schema.ts` (`bookingDrafts` constraints around line 794; new table after it)
- Create: `relay-api/drizzle/0007_booking_photos.sql` (generated)
- Create: `relay-api/src/lib/send-photo.ts`
- Modify: `relay-api/src/modules/team/team.routes.ts:35-46`
- Modify: `relay-api/src/modules/online-booking/online-booking.queries.ts`
- Modify: `relay-api/src/modules/online-booking/online-booking.service.ts`
- Modify: `relay-api/src/modules/online-booking/online-booking.schemas.ts`
- Modify: `relay-api/src/modules/online-booking/online-booking.routes.ts`
- Test: `relay-api/src/modules/online-booking/booking-photos.test.ts`

**Interfaces:**
- Consumes: `photoTypeOf(bytes: Buffer)` from `src/lib/image-type.ts`; `PROFILE_PHOTO_TYPES`; `queries.findOpenDraft`, `queries.updateDraft`.
- Produces:
  - `bookingPhotos` table, `BOOKING_PHOTO_MAX_BYTES`, `MAX_BOOKING_PHOTOS` (schema.ts)
  - `sendPhoto(res: Response, photo: { contentType: string; data: Buffer }): void` (lib/send-photo.ts)
  - Routes: `POST|GET /api/online-booking/drafts/:token/photos`, `GET|DELETE /api/online-booking/drafts/:token/photos/:photoId`
  - A photo in JSON is `{ id: string, url: string }`, `url` = `/online-booking/drafts/<token>/photos/<id>`
  - `PhotoParams` Zod schema (online-booking.schemas.ts)

- [ ] **Step 1: Write the failing tests**

Create `relay-api/src/modules/online-booking/booking-photos.test.ts`:

```ts
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createJob, createShop, resetDb } from '../../../test/helpers.ts'
import { createApp } from '../../app.ts'
import { db } from '../../db/client.ts'
import { bookingDrafts, bookingPhotos, serviceAreaZips } from '../../db/schema.ts'

vi.mock('../../realtime/index.ts', () => ({ emitToTenant: vi.fn() }))

const app = createApp()

beforeEach(async () => {
  await resetDb()
})

// A real 1×1 PNG, and the first bytes that mark a JPEG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00])

// The booking page has no sign-in: the contractor comes from the web address.
function call(method: 'get' | 'post' | 'delete', path: string, slug = 'desert') {
  return request(app)
    [method](`/api/online-booking/${path}`)
    .set('X-Tenant-Host', `${slug}.localhost`)
}

// A contractor serving 85201, and a homeowner who got as far as step 4.
async function startDraft(slug = 'desert') {
  const shop = await createShop(slug)
  await db.insert(serviceAreaZips).values({ tenantId: shop.tenant.id, zip: '85201' })
  const res = await call('post', 'drafts', slug)
    .send({ name: 'Sam Reed', phone: '(480) 555-0199', zip: '85201', consent: false })
    .expect(201)
  return { shop, token: res.body.token as string }
}

function upload(token: string, photo: Buffer, slug = 'desert') {
  return call('post', `drafts/${token}/photos`, slug).set('Content-Type', 'image/jpeg').send(photo)
}

describe('POST /api/online-booking/drafts/:token/photos', () => {
  it('saves a photo the wizard can list and show', async () => {
    const { token } = await startDraft()

    const res = await upload(token, PNG).expect(201)

    const { id, url } = res.body.photo
    expect(url).toBe(`/online-booking/drafts/${token}/photos/${id}`)
    const list = await call('get', `drafts/${token}/photos`).expect(200)
    expect(list.body).toEqual({ photos: [{ id, url }] })

    // An <img> sends no X-Tenant-Host: the token alone finds the photo.
    const image = await request(app).get(`/api${url}`).expect(200)
    expect(image.headers['content-type']).toBe('image/png') // from the bytes, not the upload's claim
    expect(image.headers['x-content-type-options']).toBe('nosniff')
    expect(image.headers['cache-control']).toBe('private, max-age=31536000, immutable')
    expect(Buffer.compare(image.body, PNG)).toBe(0)
  })

  it('takes JPEG, PNG and WebP up to 1 MB, and nothing else', async () => {
    const { token } = await startDraft()

    const notPhoto = await upload(token, Buffer.from('GIF89a')).expect(422)
    expect(notPhoto.body.error).toEqual({
      code: 'not_a_photo',
      message: 'Pick a JPEG, PNG or WebP photo.',
    })

    const atLimit = Buffer.concat([JPEG, Buffer.alloc(1024 * 1024 - JPEG.length)])
    await upload(token, atLimit).expect(201)
    const tooBig = await upload(token, Buffer.concat([atLimit, Buffer.alloc(1)])).expect(413)
    expect(tooBig.body.error).toEqual({
      code: 'photo_too_large',
      message: 'That photo is too large. Pick a smaller one.',
    })
  })

  it('takes at most 3 photos per draft', async () => {
    const { token } = await startDraft()
    for (let i = 0; i < 3; i++) await upload(token, JPEG).expect(201)

    const res = await upload(token, JPEG).expect(409)

    expect(res.body.error).toEqual({
      code: 'too_many_photos',
      message: 'You can add up to 3 photos.',
    })
    expect(await db.select().from(bookingPhotos)).toHaveLength(3)
  })

  it('counts as activity, so the recovery text waits', async () => {
    const { token } = await startDraft()
    const anHourAgo = new Date(Date.now() - 60 * 60_000)
    await db.update(bookingDrafts).set({ lastActivityAt: anHourAgo })

    await upload(token, JPEG).expect(201)

    const [draft] = await db.select().from(bookingDrafts)
    expect(draft.lastActivityAt.getTime()).toBeGreaterThan(anHourAgo.getTime())
  })
})

describe('DELETE /api/online-booking/drafts/:token/photos/:photoId', () => {
  it('removes the photo, and removing it again is fine', async () => {
    const { token } = await startDraft()
    const { body } = await upload(token, JPEG).expect(201)

    await call('delete', `drafts/${token}/photos/${body.photo.id}`).expect(200, { ok: true })
    await call('delete', `drafts/${token}/photos/${body.photo.id}`).expect(200, { ok: true })

    const list = await call('get', `drafts/${token}/photos`).expect(200)
    expect(list.body).toEqual({ photos: [] })
    await request(app).get(`/api${body.photo.url}`).expect(404)
  })
})

describe('draft photos stay private', () => {
  it('hides them from unknown tokens, other contractors and booked drafts', async () => {
    const { shop, token } = await startDraft()
    await startDraft('other')
    const { body } = await upload(token, JPEG).expect(201)
    const { id, url } = body.photo

    await upload('nope', JPEG).expect(404)
    await upload(token, JPEG, 'other').expect(404)
    await call('get', `drafts/${token}/photos`, 'other').expect(404)
    await call('delete', `drafts/${token}/photos/${id}`, 'other').expect(404)
    await request(app).get(`/api/online-booking/drafts/${token}/photos/${randomUUID()}`).expect(404)
    await request(app).get(`/api/online-booking/drafts/${token}/photos/nope`).expect(400)

    // Once booked, the photos belong to the job: the draft's routes no longer show them.
    const job = await createJob(shop)
    await db
      .update(bookingDrafts)
      .set({ bookedJobId: job.id })
      .where(eq(bookingDrafts.token, token))
    await upload(token, JPEG).expect(404)
    await call('get', `drafts/${token}/photos`).expect(404)
    await request(app).get(`/api${url}`).expect(404)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (in `relay-api`): `npx vitest run src/modules/online-booking/booking-photos.test.ts`
Expected: FAIL. The photo routes don't exist yet: `expected 201 "Created", got 404 "Not Found"`.

- [ ] **Step 3: Add the table to the schema**

In `relay-api/src/db/schema.ts`, give `bookingDrafts` the tenant key the photos reference. Its constraint array starts:

```ts
  (t) => [
    foreignKey({
      name: 'booking_drafts_booked_job_fk',
```

Change it to:

```ts
  (t) => [
    unique().on(t.tenantId, t.id),
    foreignKey({
      name: 'booking_drafts_booked_job_fk',
```

Then add right after the closing `)` of `bookingDrafts` (before the `// 3 · Two-way text inbox` banner):

```ts
export const BOOKING_PHOTO_MAX_BYTES = 1024 * 1024
export const MAX_BOOKING_PHOTOS = 3

// Photos of the unit a homeowner added on step 4 of the booking wizard. They stay with the
// draft; a booked job finds them through booking_drafts.booked_job_id. The browser shrinks
// them before upload, so the bytes live here like profile photos.
export const bookingPhotos = pgTable(
  'booking_photos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    draftId: uuid('draft_id').notNull(),
    contentType: text('content_type', { enum: PROFILE_PHOTO_TYPES }).notNull(),
    data: bytea('data').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'booking_photos_draft_fk',
      columns: [t.tenantId, t.draftId],
      foreignColumns: [bookingDrafts.tenantId, bookingDrafts.id],
    }),
    check('booking_photos_content_type_valid', oneOf(t.contentType, PROFILE_PHOTO_TYPES)),
    check(
      'booking_photos_size',
      sql`octet_length(${t.data}) between 1 and ${sql.raw(String(BOOKING_PHOTO_MAX_BYTES))}`,
    ),
    index('booking_photos_draft_idx').on(t.tenantId, t.draftId),
  ],
)
```

- [ ] **Step 4: Generate the migration and check its order**

Run (in `relay-api`): `npx drizzle-kit generate --name booking_photos`
Expected: `drizzle/0007_booking_photos.sql` and `drizzle/meta/0007_snapshot.json` are created.

Open `drizzle/0007_booking_photos.sql` and check it contains, in an order where the unique constraint comes before the foreign key that needs it:
- `CREATE TABLE "booking_photos"` with both checks,
- `ALTER TABLE "booking_drafts" ADD CONSTRAINT "booking_drafts_tenant_id_id_unique" UNIQUE("tenant_id","id")`,
- `ALTER TABLE "booking_photos" ADD CONSTRAINT "booking_photos_draft_fk" FOREIGN KEY ("tenant_id","draft_id") REFERENCES "public"."booking_drafts"("tenant_id","id")`,
- `CREATE INDEX "booking_photos_draft_idx"`.

If the `booking_photos_draft_fk` statement comes before the `UNIQUE` one, move the `UNIQUE` statement (with its `--> statement-breakpoint`) above it.

- [ ] **Step 5: Add the shared photo response**

Create `relay-api/src/lib/send-photo.ts`:

```ts
import type { Response } from 'express'

// Sends a stored photo. `nosniff` keeps browsers to the type that was checked on upload. A
// photo's URL always points at the same bytes, so browsers may keep it.
export function sendPhoto(res: Response, photo: { contentType: string; data: Buffer }) {
  res
    .set({
      'Content-Type': photo.contentType,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=31536000, immutable',
    })
    .send(photo.data)
}
```

In `relay-api/src/modules/team/team.routes.ts`, add `import { sendPhoto } from '../../lib/send-photo.ts'` and replace the body of the `GET /technicians/:technicianId/photo` handler:

```ts
// Staff only, like the list.
teamRoutes.get('/technicians/:technicianId/photo', staff, async (req, res) => {
  const { technicianId } = TechnicianParams.parse(req.params)
  sendPhoto(res, await team.getPhoto(tenantOf(req.user!), technicianId))
})
```

- [ ] **Step 6: Add the queries**

In `relay-api/src/modules/online-booking/online-booking.queries.ts`:

Add `bookingPhotos` to the schema import list (alphabetical, after `bookingDrafts`).

Change the top comment to:

```ts
// Tenant-scoped: every query takes tenantId first, except the system jobs' queries
// (expireHolds, listDraftsToRecover, deleteIdleDraftPhotos) and findDraftPhoto, which work
// across contractors.
```

Add after `findOpenDraft`:

```ts
// Like findOpenDraft, and locks the draft until the transaction ends, so two uploads at once
// can't both take the last photo place.
export async function lockOpenDraft(tenantId: string, token: string, tx: Db) {
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
    .for('update')
  return draft
}
```

Add after `markDraftBooked`:

```ts
// The draft's photos, oldest first.
export function listDraftPhotos(tenantId: string, draftId: string, tx: Db = db) {
  return tx
    .select({ id: bookingPhotos.id })
    .from(bookingPhotos)
    .where(and(eq(bookingPhotos.tenantId, tenantId), eq(bookingPhotos.draftId, draftId)))
    .orderBy(asc(bookingPhotos.createdAt))
}

export async function insertDraftPhoto(
  tenantId: string,
  values: Pick<typeof bookingPhotos.$inferInsert, 'draftId' | 'contentType' | 'data'>,
  tx: Db,
) {
  const [photo] = await tx
    .insert(bookingPhotos)
    .values({ ...values, tenantId })
    .returning({ id: bookingPhotos.id })
  return photo
}

export async function deleteDraftPhoto(tenantId: string, draftId: string, photoId: string) {
  await db
    .delete(bookingPhotos)
    .where(
      and(
        eq(bookingPhotos.tenantId, tenantId),
        eq(bookingPhotos.draftId, draftId),
        eq(bookingPhotos.id, photoId),
      ),
    )
}

// A photo's image, found by its draft's token alone (tokens are unique across Relay). Only
// while the draft is open.
export async function findDraftPhoto(token: string, photoId: string) {
  const [photo] = await db
    .select({ contentType: bookingPhotos.contentType, data: bookingPhotos.data })
    .from(bookingPhotos)
    .innerJoin(
      bookingDrafts,
      and(
        eq(bookingDrafts.tenantId, bookingPhotos.tenantId),
        eq(bookingDrafts.id, bookingPhotos.draftId),
      ),
    )
    .where(
      and(
        eq(bookingDrafts.token, token),
        isNull(bookingDrafts.bookedJobId),
        eq(bookingPhotos.id, photoId),
      ),
    )
  return photo
}
```

- [ ] **Step 7: Add the service functions**

In `relay-api/src/modules/online-booking/online-booking.service.ts`:

Add imports:

```ts
import { BOOKING_PHOTO_MAX_BYTES, MAX_BOOKING_PHOTOS } from '../../db/schema.ts'
import { photoTypeOf } from '../../lib/image-type.ts'
```

Add next to `DRAFT_GONE`:

```ts
const PHOTO_GONE = 'That photo isn’t available anymore.'
```

Add after `getDraft`:

```ts
// A draft photo as the wizard gets it. `url` is a path under the API, like a technician's
// photoUrl; the web app puts the API's address in front.
function draftPhoto(token: string, photoId: string) {
  return { id: photoId, url: `/online-booking/drafts/${token}/photos/${photoId}` }
}

// Step 4: a photo of the unit, for a homeowner who isn't sure what they have. Adding one
// counts as activity, like saving answers.
export async function addDraftPhoto(tenantId: string, token: string, body: unknown) {
  const contentType = Buffer.isBuffer(body) ? photoTypeOf(body) : null
  if (!Buffer.isBuffer(body) || !contentType) {
    throw new HttpError(422, 'not_a_photo', 'Pick a JPEG, PNG or WebP photo.')
  }
  if (body.length > BOOKING_PHOTO_MAX_BYTES) {
    throw new HttpError(413, 'photo_too_large', 'That photo is too large. Pick a smaller one.')
  }
  return db.transaction(async (tx) => {
    const draft = await queries.lockOpenDraft(tenantId, token, tx)
    if (!draft) throw new HttpError(404, 'not_found', DRAFT_GONE)
    const photos = await queries.listDraftPhotos(tenantId, draft.id, tx)
    if (photos.length >= MAX_BOOKING_PHOTOS) {
      throw new HttpError(409, 'too_many_photos', `You can add up to ${MAX_BOOKING_PHOTOS} photos.`)
    }
    const photo = await queries.insertDraftPhoto(
      tenantId,
      { draftId: draft.id, contentType, data: body },
      tx,
    )
    await queries.updateDraft(tenantId, draft.id, {}, tx)
    return { photo: draftPhoto(token, photo.id) }
  })
}

export async function listDraftPhotos(tenantId: string, token: string) {
  const draft = await queries.findOpenDraft(tenantId, token)
  if (!draft) throw new HttpError(404, 'not_found', DRAFT_GONE)
  const photos = await queries.listDraftPhotos(tenantId, draft.id)
  return { photos: photos.map((photo) => draftPhoto(token, photo.id)) }
}

// Removing a photo that is already gone is harmless.
export async function removeDraftPhoto(tenantId: string, token: string, photoId: string) {
  const draft = await queries.findOpenDraft(tenantId, token)
  if (!draft) throw new HttpError(404, 'not_found', DRAFT_GONE)
  await queries.deleteDraftPhoto(tenantId, draft.id, photoId)
  await queries.updateDraft(tenantId, draft.id, {})
}

export async function getDraftPhoto(token: string, photoId: string) {
  const photo = await queries.findDraftPhoto(token, photoId)
  if (!photo) throw new HttpError(404, 'not_found', PHOTO_GONE)
  return photo
}
```

- [ ] **Step 8: Add the photo id schema**

In `relay-api/src/modules/online-booking/online-booking.schemas.ts` add (it already imports `z`):

```ts
export const PhotoParams = z.object({ photoId: z.uuid('That photo link isn’t valid') })
```

- [ ] **Step 9: Add the routes**

In `relay-api/src/modules/online-booking/online-booking.routes.ts`:

Change `import { Router } from 'express'` to `import express, { Router } from 'express'`, add `PhotoParams` to the schemas import, and add `import { sendPhoto } from '../../lib/send-photo.ts'`.

Add after `const draftLimit = limitTries(240)`:

```ts
// Step 4 photos are up to 1 MB each, so uploads get a smaller count on top of the draft one.
const photoLimit = limitTries(30)
// A photo is the request body itself, not JSON. The service refuses anything that isn't a
// small JPEG, PNG or WebP, whatever the upload says it is.
const photoBody = express.raw({ type: () => true, limit: '2mb' })
```

Add after the `PATCH /online-booking/drafts/:token` route:

```ts
onlineBookingRoutes.get(
  '/online-booking/drafts/:token/photos',
  draftLimit,
  tenantFromHost,
  async (req, res) => {
    res.json(await onlineBooking.listDraftPhotos(req.tenant!.id, String(req.params.token)))
  },
)

onlineBookingRoutes.post(
  '/online-booking/drafts/:token/photos',
  photoLimit,
  draftLimit,
  tenantFromHost,
  photoBody,
  async (req, res) => {
    const photo = await onlineBooking.addDraftPhoto(
      req.tenant!.id,
      String(req.params.token),
      req.body,
    )
    res.status(201).json(photo)
  },
)

// No tenantFromHost: an <img> can't send X-Tenant-Host. Tokens are unique across Relay, so
// the token alone finds the draft.
onlineBookingRoutes.get(
  '/online-booking/drafts/:token/photos/:photoId',
  draftLimit,
  async (req, res) => {
    const { photoId } = PhotoParams.parse(req.params)
    sendPhoto(res, await onlineBooking.getDraftPhoto(String(req.params.token), photoId))
  },
)

onlineBookingRoutes.delete(
  '/online-booking/drafts/:token/photos/:photoId',
  draftLimit,
  tenantFromHost,
  async (req, res) => {
    const { photoId } = PhotoParams.parse(req.params)
    await onlineBooking.removeDraftPhoto(req.tenant!.id, String(req.params.token), photoId)
    res.json({ ok: true })
  },
)
```

- [ ] **Step 10: Run the new tests, then the whole API suite**

Run: `npx vitest run src/modules/online-booking/booking-photos.test.ts`
Expected: PASS, 7 tests.

Run: `npm test`
Expected: PASS, including `team.test.ts` (the technician photo route now uses `sendPhoto`).

- [ ] **Step 11: Typecheck, lint, commit**

```bash
npm run typecheck
npx biome check --write src/db/schema.ts src/lib/send-photo.ts src/modules/team/team.routes.ts src/modules/online-booking/online-booking.queries.ts src/modules/online-booking/online-booking.service.ts src/modules/online-booking/online-booking.schemas.ts src/modules/online-booking/online-booking.routes.ts src/modules/online-booking/booking-photos.test.ts
git add src/db/schema.ts drizzle src/lib/send-photo.ts src/modules/team/team.routes.ts src/modules/online-booking
git commit -m "feat: let homeowners add photos to a booking draft"
```

Expected: typecheck prints nothing; Biome reports no errors. (`drizzle/` is excluded in `biome.json`.)

---

### Task 3: API — photos for the office, and the cleanup job

**Files:**
- Modify: `relay-api/src/modules/dispatch/dispatch.queries.ts`
- Modify: `relay-api/src/modules/dispatch/dispatch.service.ts:53-70`
- Modify: `relay-api/src/modules/dispatch/dispatch.schemas.ts`
- Modify: `relay-api/src/modules/dispatch/dispatch.routes.ts`
- Modify: `relay-api/src/modules/online-booking/online-booking.queries.ts`
- Modify: `relay-api/src/modules/online-booking/online-booking.service.ts`
- Modify: `relay-api/src/jobs/index.ts`
- Test: `relay-api/src/modules/dispatch/dispatch.test.ts`, `relay-api/src/modules/online-booking/booking-photos.test.ts`

**Interfaces:**
- Consumes: `bookingPhotos`, `bookingDrafts` (schema.ts); `sendPhoto` (lib/send-photo.ts).
- Produces:
  - `GET /api/jobs/:jobId` response gains `photos: { id: string, url: string }[]`, `url` = `/jobs/<jobId>/photos/<id>`
  - Route `GET /api/jobs/:jobId/photos/:photoId` (staff)
  - `deleteIdlePhotos(): Promise<number>` (online-booking.service.ts)
  - pg-boss job `booking-photo-cleanup`

- [ ] **Step 1: Write the failing dispatch tests**

In `relay-api/src/modules/dispatch/dispatch.test.ts`:

Change the helpers import to include the `Shop` type: add `type Shop,` to the `'../../../test/helpers.ts'` import list. Change the schema import to:

```ts
import { auditEvents, bookingDrafts, bookingPhotos, jobs, users } from '../../db/schema.ts'
```

Add below `const app = createApp()`:

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
      name: 'Sam Reed',
      phone: '+14805550199',
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
```

In the existing test `'returns everything the job drawer shows'`, add after the `notes` expectation:

```ts
    expect(res.body.photos).toEqual([]) // booked by the office: no homeowner photos
```

Add inside `describe('GET /api/jobs/:jobId', …)`, after the 404 test:

```ts
  it("shows the homeowner's booking photos to staff only", async () => {
    const shop = await createShop('desert')
    const job = await createJob(shop)
    const otherJob = await createJob(shop, { at: `${TUESDAY} 12:00` })
    const photo = await addBookingPhoto(shop, job.id, 'token-a')
    const otherPhoto = await addBookingPhoto(shop, otherJob.id, 'token-b')

    const res = await request(app).get(`/api/jobs/${job.id}`).set('Cookie', shop.cookie).expect(200)
    expect(res.body.photos).toEqual([{ id: photo.id, url: `/jobs/${job.id}/photos/${photo.id}` }])

    const image = await request(app)
      .get(`/api${res.body.photos[0].url}`)
      .set('Cookie', shop.cookie)
      .expect(200)
    expect(image.headers['content-type']).toBe('image/jpeg')
    expect(image.headers['x-content-type-options']).toBe('nosniff')
    expect(Buffer.compare(image.body, JPEG)).toBe(0)

    const wrongJob = await request(app)
      .get(`/api/jobs/${job.id}/photos/${otherPhoto.id}`)
      .set('Cookie', shop.cookie)
      .expect(404)
    expect(wrongJob.body.error.message).toBe('That photo isn’t on this job.')
    await request(app).get(`/api/jobs/${job.id}/photos/${photo.id}`).expect(401)
  })
```

- [ ] **Step 2: Write the failing cleanup test**

In `relay-api/src/modules/online-booking/booking-photos.test.ts`, add `import { deleteIdlePhotos } from './online-booking.service.ts'` to the imports, and append:

```ts
// A draft straight in the database, with one photo. Returns the draft's id.
async function insertDraftWithPhoto(
  tenantId: string,
  token: string,
  values: Partial<typeof bookingDrafts.$inferInsert>,
) {
  const [draft] = await db
    .insert(bookingDrafts)
    .values({ tenantId, token, name: 'Sam Reed', phone: '+14805550199', zip: '85201', ...values })
    .returning()
  await db
    .insert(bookingPhotos)
    .values({ tenantId, draftId: draft.id, contentType: 'image/jpeg', data: JPEG })
  return draft.id
}

describe('deleteIdlePhotos', () => {
  it('deletes photos of drafts nobody booked or touched for 30 days, and keeps the rest', async () => {
    const shop = await createShop('desert')
    const job = await createJob(shop)
    const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60_000)
    await insertDraftWithPhoto(shop.tenant.id, 'idle', { lastActivityAt: daysAgo(31) })
    const recent = await insertDraftWithPhoto(shop.tenant.id, 'recent', {
      lastActivityAt: daysAgo(29),
    })
    const booked = await insertDraftWithPhoto(shop.tenant.id, 'booked', {
      lastActivityAt: daysAgo(31),
      bookedJobId: job.id,
    })

    expect(await deleteIdlePhotos()).toBe(1)

    const left = await db.select({ draftId: bookingPhotos.draftId }).from(bookingPhotos)
    expect(left.map((photo) => photo.draftId).sort()).toEqual([recent, booked].sort())
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/modules/dispatch/dispatch.test.ts src/modules/online-booking/booking-photos.test.ts`
Expected: FAIL. `res.body.photos` is `undefined`; the staff image route answers 404 for the right photo; `deleteIdlePhotos` is not exported.

- [ ] **Step 4: Add the dispatch queries**

In `relay-api/src/modules/dispatch/dispatch.queries.ts`, add `bookingDrafts,` and `bookingPhotos,` to the schema import list (alphabetical, after `arrivalWindows`), and append:

```ts
// A booking photo and the draft it was added to.
const photoDraft = and(
  eq(bookingDrafts.tenantId, bookingPhotos.tenantId),
  eq(bookingDrafts.id, bookingPhotos.draftId),
)

// Photos the homeowner added while booking this job online (step 4), oldest first.
export function listJobPhotos(tenantId: string, jobId: string) {
  return db
    .select({ id: bookingPhotos.id })
    .from(bookingPhotos)
    .innerJoin(bookingDrafts, photoDraft)
    .where(and(eq(bookingPhotos.tenantId, tenantId), eq(bookingDrafts.bookedJobId, jobId)))
    .orderBy(asc(bookingPhotos.createdAt))
}

export async function findJobPhoto(tenantId: string, jobId: string, photoId: string) {
  const [photo] = await db
    .select({ contentType: bookingPhotos.contentType, data: bookingPhotos.data })
    .from(bookingPhotos)
    .innerJoin(bookingDrafts, photoDraft)
    .where(
      and(
        eq(bookingPhotos.tenantId, tenantId),
        eq(bookingDrafts.bookedJobId, jobId),
        eq(bookingPhotos.id, photoId),
      ),
    )
  return photo
}
```

- [ ] **Step 5: Add photos to the job detail and the photo lookup**

In `relay-api/src/modules/dispatch/dispatch.service.ts`, replace `getJob` with:

```ts
export async function getJob(tenantId: string, jobId: string) {
  const [job, notes, photos] = await Promise.all([
    queries.findJobDetail(tenantId, jobId),
    queries.listNotes(tenantId, jobId),
    queries.listJobPhotos(tenantId, jobId),
  ])
  if (!job) throw new HttpError(404, 'not_found', JOB_NOT_FOUND)
  const { localStart, localEnd, technicianId, technicianName, ...rest } = job
  return {
    job: {
      ...rest,
      dateLabel: formatDay(job.date),
      windowLabel: formatWindow(localStart, localEnd),
      technician: technicianId ? { id: technicianId, name: technicianName } : null,
      allowedStatuses: TRANSITIONS[job.status] ?? [],
    },
    notes,
    // `url` is a path under the API; the web app puts the API's address in front.
    photos: photos.map((photo) => ({ id: photo.id, url: `/jobs/${jobId}/photos/${photo.id}` })),
  }
}

// A photo the homeowner added while booking this job.
export async function getJobPhoto(tenantId: string, jobId: string, photoId: string) {
  const photo = await queries.findJobPhoto(tenantId, jobId, photoId)
  if (!photo) throw new HttpError(404, 'not_found', 'That photo isn’t on this job.')
  return photo
}
```

- [ ] **Step 6: Add the staff route**

In `relay-api/src/modules/dispatch/dispatch.schemas.ts`, add after `JobParams`:

```ts
export const JobPhotoParams = JobParams.extend({
  photoId: z.uuid('That photo link isn’t valid'),
})
```

In `relay-api/src/modules/dispatch/dispatch.routes.ts`, add `JobPhotoParams` to the schemas import, add `import { sendPhoto } from '../../lib/send-photo.ts'`, and add after the `GET /jobs/:jobId` route:

```ts
dispatchRoutes.get('/jobs/:jobId/photos/:photoId', staff, async (req, res) => {
  const { jobId, photoId } = JobPhotoParams.parse(req.params)
  sendPhoto(res, await dispatch.getJobPhoto(tenantOf(req.user!), jobId, photoId))
})
```

- [ ] **Step 7: Add the cleanup query, service function and job**

In `relay-api/src/modules/online-booking/online-booking.queries.ts`, add `inArray` to the `drizzle-orm` import and append:

```ts
// Every contractor's photos on drafts that were never booked and quiet since `idleSince`.
// Returns how many were deleted.
export async function deleteIdleDraftPhotos(idleSince: Date) {
  const idleDrafts = db
    .select({ id: bookingDrafts.id })
    .from(bookingDrafts)
    .where(and(isNull(bookingDrafts.bookedJobId), lt(bookingDrafts.lastActivityAt, idleSince)))
  const deleted = await db
    .delete(bookingPhotos)
    .where(inArray(bookingPhotos.draftId, idleDrafts))
    .returning({ id: bookingPhotos.id })
  return deleted.length
}
```

In `relay-api/src/modules/online-booking/online-booking.service.ts`, add next to the recovery constants:

```ts
// Photos on a draft nobody booked are kept this long after its last activity.
const PHOTO_KEEP_DAYS = 30
```

and after `expireHolds`:

```ts
// Run daily by the 'booking-photo-cleanup' job. Returns how many photos were deleted.
export function deleteIdlePhotos() {
  return queries.deleteIdleDraftPhotos(new Date(Date.now() - PHOTO_KEEP_DAYS * 24 * 60 * 60_000))
}
```

In `relay-api/src/jobs/index.ts`, add inside `startJobs()` after the `booking-recovery` registration:

```ts
  // Daily: photos on bookings nobody finished go 30 days after the homeowner's last activity.
  await register('booking-photo-cleanup', { cron: '30 3 * * *' }, async () => {
    const deleted = await onlineBooking.deleteIdlePhotos()
    if (deleted > 0) logger.info({ deleted }, 'Idle booking photos deleted')
  })
```

- [ ] **Step 8: Run the tests**

Run: `npx vitest run src/modules/dispatch/dispatch.test.ts src/modules/online-booking/booking-photos.test.ts`
Expected: PASS.

Run: `npm test`
Expected: PASS.

- [ ] **Step 9: Typecheck, lint, commit**

```bash
npm run typecheck
npx biome check --write src/modules/dispatch/dispatch.queries.ts src/modules/dispatch/dispatch.service.ts src/modules/dispatch/dispatch.schemas.ts src/modules/dispatch/dispatch.routes.ts src/modules/dispatch/dispatch.test.ts src/modules/online-booking/online-booking.queries.ts src/modules/online-booking/online-booking.service.ts src/modules/online-booking/booking-photos.test.ts src/jobs/index.ts
git add src/modules/dispatch src/modules/online-booking src/jobs/index.ts
git commit -m "feat: show booking photos to the office and clean up unused ones"
```

- [ ] **Step 10: Migrate the development database**

Run (in `relay-api`): `npm run db:migrate`
Expected: finishes without errors. The running dev API (`npm run dev`, `--watch`) reloads by itself.

---

### Task 4: Web — the photo card on step 4

**Files:**
- Create: `relay-web/src/features/booking/photo.ts`
- Test: `relay-web/src/features/booking/photo.test.ts`
- Modify: `relay-web/src/features/booking/api.ts`
- Create: `relay-web/src/features/booking/photo-card.tsx`
- Modify: `relay-web/src/features/booking/problem-step.tsx`
- Modify: `relay-web/src/features/booking/booking-flow.tsx` (the `ProblemStep` element)
- Modify: `relay-web/src/index.css`

**Interfaces:**
- Consumes: the homeowner routes and `{ id, url }` photo shape from Task 2; `PhotoError` from `src/features/team/photo.ts`; `api`, `ApiError` from `src/lib/api.ts`; `env` from `src/lib/env.ts`.
- Produces:
  - `fitWithin(width: number, height: number, max: number): { width: number; height: number }`, `shrinkPhoto(file: File): Promise<Blob>` (photo.ts)
  - `type DraftPhoto = { id: string; url: string }` (url already absolute), `useDraftPhotos(token)`, `useAddDraftPhoto(token)`, `useRemoveDraftPhoto(token)` (api.ts)
  - `PhotoCard({ draftToken, photos, nudged })` (photo-card.tsx)
  - `ProblemStep` gains a required `draftToken: string` prop
  - Tailwind utility `animate-shake`

- [ ] **Step 1: Write the failing resize test**

Create `relay-web/src/features/booking/photo.test.ts`:

```ts
import { expect, it } from 'vitest'
import { fitWithin } from './photo'

it('shrinks a wide phone photo to 1600 px across', () => {
  expect(fitWithin(4032, 3024, 1600)).toEqual({ width: 1600, height: 1200 })
})

it('shrinks a tall phone photo to 1600 px high', () => {
  expect(fitWithin(3024, 4032, 1600)).toEqual({ width: 1200, height: 1600 })
})

it('keeps a photo that is already small enough', () => {
  expect(fitWithin(800, 600, 1600)).toEqual({ width: 800, height: 600 })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run (in `relay-web`): `npx vitest run src/features/booking/photo.test.ts`
Expected: FAIL, `Failed to resolve import "./photo"`.

- [ ] **Step 3: Write the resize helper**

Create `relay-web/src/features/booking/photo.ts`:

```ts
import { PhotoError } from '@/features/team/photo'

// A homeowner's photo of their unit is shrunk here, in the browser, before it is uploaded:
// small enough to send quickly on a phone, big enough to read the unit's label. Saving it
// again as a JPEG also drops the phone's location data.

const LONGEST_SIDE = 1600 // pixels

// The size that fits within `max` on its longest side. A smaller photo keeps its size.
export function fitWithin(width: number, height: number, max: number) {
  const scale = Math.min(1, max / Math.max(width, height))
  return { width: Math.round(width * scale), height: Math.round(height * scale) }
}

// The photo as a JPEG at most LONGEST_SIDE across. Throws PhotoError when it can't be read.
export async function shrinkPhoto(file: File): Promise<Blob> {
  let picture: ImageBitmap
  try {
    picture = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    throw new PhotoError()
  }
  const { width, height } = fitWithin(picture.width, picture.height, LONGEST_SIDE)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context || width === 0 || height === 0) throw new PhotoError()
  // JPEG has no transparency: see-through parts of a PNG become white, not black.
  context.fillStyle = '#fff'
  context.fillRect(0, 0, width, height)
  context.drawImage(picture, 0, 0, width, height)
  picture.close()
  const photo = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', 0.8),
  )
  if (!photo) throw new PhotoError()
  return photo
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/features/booking/photo.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Add the photo hooks**

In `relay-web/src/features/booking/api.ts`:

Add `import { env } from '@/lib/env'` to the imports.

Add after the `Draft` schema and its type:

```ts
// A photo on the draft. `url` arrives as a path under the API; made loadable here, like
// technician photos.
const DraftPhoto = z.object({
  id: z.string(),
  url: z.string().transform((path) => `${env.VITE_API_URL}${path}`),
})
export type DraftPhoto = z.infer<typeof DraftPhoto>
const DraftPhotos = z.object({ photos: z.array(DraftPhoto) })
const PhotoAdded = z.object({ photo: DraftPhoto })
```

Add after `useSaveDraftAnswers`:

```ts
const draftPhotosKey = (token: string) => ['online-booking', 'draft-photos', token]

// Step 4: the photos already on the draft, oldest first.
export function useDraftPhotos(token: string) {
  return useQuery({
    queryKey: draftPhotosKey(token),
    enabled: token !== '',
    queryFn: () => api.get(`/online-booking/drafts/${token}/photos`, DraftPhotos),
    select: (data) => data.photos,
  })
}

// `photo` is already shrunk (photo.ts). The list reloads before the call counts as done, so
// the new thumbnail is there when the "uploading" one goes away.
export function useAddDraftPhoto(token: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (photo: Blob) =>
      api.post(`/online-booking/drafts/${token}/photos`, photo, PhotoAdded),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: draftPhotosKey(token) }),
  })
}

export function useRemoveDraftPhoto(token: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (photoId: string) =>
      api.delete(`/online-booking/drafts/${token}/photos/${photoId}`, Sent),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: draftPhotosKey(token) }),
  })
}
```

- [ ] **Step 6: Add the shake animation**

In `relay-web/src/index.css`, add after the closing `}` of the `@theme inline { … }` block:

```css
/* The booking wizard's photo nudge (features/booking/photo-card.tsx). */
@theme {
  --animate-shake: shake 0.4s ease-in-out;

  @keyframes shake {
    0%,
    100% {
      transform: translateX(0);
    }
    20%,
    60% {
      transform: translateX(-6px);
    }
    40%,
    80% {
      transform: translateX(6px);
    }
  }
}
```

- [ ] **Step 7: Write the photo card**

Create `relay-web/src/features/booking/photo-card.tsx`:

```tsx
import { cn } from 'cn'
import { Camera, Loader2, X } from 'lucide-react'
import { type ChangeEvent, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { PhotoError } from '@/features/team/photo'
import { ApiError } from '@/lib/api'
import { type DraftPhoto, useAddDraftPhoto, useRemoveDraftPhoto } from './api'
import { Panel } from './booking-ui'
import { shrinkPhoto } from './photo'

const MAX_PHOTOS = 3 // relay-api's MAX_BOOKING_PHOTOS
const UPLOAD_FAILED = 'We couldn’t add this photo. You can still book without it.'

// Step 4's photo card, for a homeowner who picked "Not sure" or "Other": up to 3 photos of the
// unit, saved with the draft as soon as they are picked. Optional. `nudged` is set by the first
// Continue without a photo: the card shakes once and asks again.
export function PhotoCard({
  draftToken,
  photos,
  nudged,
}: {
  draftToken: string
  photos: DraftPhoto[]
  nudged: boolean
}) {
  const fileInput = useRef<HTMLInputElement>(null)
  // Photos still on their way up, shown from the phone's own copy until the API has them.
  const [uploading, setUploading] = useState<string[]>([])
  const [error, setError] = useState('')
  const addPhoto = useAddDraftPhoto(draftToken)
  const removePhoto = useRemoveDraftPhoto(draftToken)
  const free = MAX_PHOTOS - photos.length - uploading.length

  // One photo after another, so two uploads never race for the last free place.
  async function onPick(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []).slice(0, free)
    event.currentTarget.value = '' // so picking the same photo again still counts
    setError('')
    for (const file of files) {
      const preview = URL.createObjectURL(file)
      setUploading((list) => [...list, preview])
      try {
        await addPhoto.mutateAsync(await shrinkPhoto(file))
      } catch (failure) {
        if (failure instanceof PhotoError || (failure instanceof ApiError && failure.status < 500)) {
          setError(failure.message)
        } else {
          console.error('Adding a booking photo failed', failure)
          setError(UPLOAD_FAILED)
        }
      } finally {
        setUploading((list) => list.filter((item) => item !== preview))
        URL.revokeObjectURL(preview)
      }
    }
  }

  function onRemove(photoId: string) {
    removePhoto.mutate(photoId, {
      onError: () => toast.error('We couldn’t remove that photo. Try again.'),
    })
  }

  return (
    <Panel
      id="booking-photos"
      className={cn(
        'space-y-4 bg-primary/5 ring-1 ring-primary/20',
        nudged && 'animate-shake motion-reduce:animate-none',
      )}
    >
      <div className="flex items-start gap-3">
        <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Camera className="size-6" />
        </span>
        <div className="space-y-1">
          <h3 className="font-semibold">Add a photo of your unit</h3>
          <p className="text-sm text-muted-foreground">
            A photo of your unit and its label helps your technician bring the right parts.
          </p>
        </div>
      </div>

      {(photos.length > 0 || uploading.length > 0) && (
        <ul className="grid grid-cols-3 gap-3">
          {photos.map((photo, index) => (
            <li key={photo.id} className="relative">
              <img
                src={photo.url}
                alt={`Your photo ${index + 1}`}
                className="aspect-square w-full rounded-xl object-cover"
              />
              <button
                type="button"
                aria-label={`Remove photo ${index + 1}`}
                className="absolute top-1.5 right-1.5 flex size-8 items-center justify-center rounded-full bg-black/60 text-white outline-none hover:bg-black/75 focus-visible:ring-3 focus-visible:ring-ring/50"
                onClick={() => onRemove(photo.id)}
              >
                <X className="size-4" />
              </button>
            </li>
          ))}
          {uploading.map((preview) => (
            <li key={preview} className="relative">
              <img
                src={preview}
                alt=""
                className="aspect-square w-full rounded-xl object-cover opacity-50"
              />
              <Loader2 className="absolute inset-0 m-auto size-6 animate-spin text-primary" />
              <span className="sr-only">Uploading…</span>
            </li>
          ))}
        </ul>
      )}

      {free > 0 && (
        <>
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={onPick}
          />
          <Button
            type="button"
            variant="outline"
            className="h-11 w-full bg-background"
            onClick={() => fileInput.current?.click()}
          >
            <Camera />
            Take or choose a photo
          </Button>
        </>
      )}

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {nudged && (
        <p role="status" className="text-sm font-medium text-primary">
          A photo really helps. Add one, or tap Continue again to skip.
        </p>
      )}
    </Panel>
  )
}
```

- [ ] **Step 8: Show the card on step 4, with the nudge**

In `relay-web/src/features/booking/problem-step.tsx`:

Add imports:

```ts
import { useDraftPhotos } from './api'
import { PhotoCard } from './photo-card'
```

Replace the component's top comment and props with:

```tsx
// Step 4: the intake questions. The safety question comes first: a gas smell or a carbon
// monoxide alarm is never booked, it gets the safety screen. `priorityFeeCents` is 0 when the
// contractor doesn't offer priority service. A homeowner who isn't sure what system they have
// is asked for photos of it (`draftToken` is the draft they are saved to).
export function ProblemStep({
  answers,
  draftToken,
  priorityFeeCents,
  onDone,
}: {
  answers: Answers
  draftToken: string
  priorityFeeCents: number
  onDone: (answers: ProblemAnswers) => void
}) {
```

Add after `const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})`:

```tsx
  const [nudged, setNudged] = useState(false) // the first Continue without a photo was stopped
  const photos = useDraftPhotos(draftToken).data ?? []
  // Kept on screen once photos are added, so switching the system type can't hide them.
  const showPhotos = systemType === 'not_sure' || systemType === 'other' || photos.length > 0
```

In `onSubmit`, replace:

```tsx
    if (Object.keys(errors).length > 0) return
    onDone({ problem: problem.trim(), systemType, vulnerableOccupant, priorityService })
```

with:

```tsx
    if (Object.keys(errors).length > 0) return
    // Optional, but asked twice: the first Continue without a photo stops at the photo card.
    if (showPhotos && photos.length === 0 && !nudged) {
      setNudged(true)
      document.getElementById('booking-photos')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      return
    }
    onDone({ problem: problem.trim(), systemType, vulnerableOccupant, priorityService })
```

In the JSX, right after the `</Panel>` that closes the "What kind of system?" fieldset panel, add:

```tsx
          {showPhotos && (
            <PhotoCard
              draftToken={draftToken}
              photos={photos}
              nudged={nudged && photos.length === 0}
            />
          )}
```

- [ ] **Step 9: Pass the draft token from the wizard**

In `relay-web/src/features/booking/booking-flow.tsx`, change the `ProblemStep` element to:

```tsx
          <ProblemStep
            answers={answers}
            draftToken={draftToken}
            priorityFeeCents={priorityFeeCents}
            onDone={(problem) => go('time', problem)}
          />
```

- [ ] **Step 10: Typecheck, test, lint, commit**

```bash
npm run typecheck
npm test
npx biome check --write src/features/booking/photo.ts src/features/booking/photo.test.ts src/features/booking/photo-card.tsx src/features/booking/api.ts src/features/booking/problem-step.tsx src/features/booking/booking-flow.tsx src/index.css
git add src/features/booking src/index.css
git commit -m "feat: ask for photos on step 4 when the system is unknown"
```

Expected: typecheck prints nothing; all tests pass; Biome reports no errors.

---

### Task 5: Web — thumbnails in the job drawer

**Files:**
- Modify: `relay-web/src/features/dispatch/api.ts` (`JobDetail` schema, around line 60)
- Modify: `relay-web/src/features/dispatch/job-drawer.tsx` (`JobDetails`, Problem section around line 117)

**Interfaces:**
- Consumes: `photos: { id, url }[]` in `GET /api/jobs/:jobId` (Task 3).
- Produces: `JobDetail['photos']` with absolute `url`s.

- [ ] **Step 1: Add photos to the job detail schema**

In `relay-web/src/features/dispatch/api.ts`, add `import { env } from '@/lib/env'`, and add to `JobDetail` after `notes: z.array(…)`:

```ts
  // Photos the homeowner added while booking online. `url` arrives as a path under the API.
  photos: z.array(
    z.object({
      id: z.string(),
      url: z.string().transform((path) => `${env.VITE_API_URL}${path}`),
    }),
  ),
```

- [ ] **Step 2: Show them in the Problem section**

In `relay-web/src/features/dispatch/job-drawer.tsx`, in `JobDetails` change `const { job, notes } = detail` to `const { job, notes, photos } = detail`, and in the Problem section add after the `System:` paragraph:

```tsx
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
                      alt={`Homeowner’s photo ${index + 1}`}
                      className="size-20 rounded-lg object-cover"
                    />
                  </a>
                </li>
              ))}
            </ul>
          )}
```

- [ ] **Step 3: Typecheck, test, lint, commit**

```bash
npm run typecheck
npm test
npx biome check --write src/features/dispatch/api.ts src/features/dispatch/job-drawer.tsx
git add src/features/dispatch/api.ts src/features/dispatch/job-drawer.tsx
git commit -m "feat: show the homeowner's booking photos in the job drawer"
```

---

### Task 6: Check it in the running app

**Files:** none in the repos (screenshots go to the session scratchpad).

- [ ] **Step 1: Walk through step 4 in a browser at phone, tablet and desktop widths**

With relay-api (`npm run dev`) and relay-web (`npm run dev`) running, open `http://desert.localhost:5173/?step=service`:
1. Pick a service, enter ZIP `85004`, fill the contact step (any name, a valid phone).
2. On step 4 answer "No, we're safe", type a problem, pick **Not sure**. Expected: the tinted photo card appears.
3. Tap Continue with no photo. Expected: the card shakes once and shows the nudge; the step doesn't move.
4. Add a JPEG. Expected: a dimmed thumbnail with a spinner, then the real thumbnail with ✕.
5. Refresh the page. Expected: step 4 still shows the photo.
6. Tap ✕. Expected: it goes away. Add it again, then Continue goes to step 5.
7. Pick **Central AC** after adding a photo. Expected: the card stays.

- [ ] **Step 2: Book it and check the drawer**

Finish steps 5 and 6. Sign in as `office@desert.test` at `http://desert.localhost:5173/sign-in`, open the dashboard on the booked day, open the job. Expected: the Problem section shows the thumbnail; clicking it opens the photo in a new tab.

- [ ] **Step 3: Report**

Report the screenshots and anything that didn't match the expected results.
