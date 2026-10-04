# Technician Job Photos Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the technician job page, a technician with a visit in progress can add **Before** photos at diagnosis and **After** photos when the repair is done, remove one they didn't want, and see both groups beside the homeowner's booking photos. The office sees the same two groups in the dispatch job drawer, read-only.

**Architecture:** Photos are shrunk in the browser and stored in Postgres, in the existing `job_photos` table with `stage = 'before' | 'after'` and `uploaded_by` = the technician. `job_photos` is empty everywhere (nothing writes it today), so migration `0010` drops its unused `storage_key` and gives it `content_type` + `data bytea`, like `user_photos` and `booking_photos`. The four queries live in `dispatch.queries.ts`, which `technician-jobs` already depends on (never the other way): `dispatch` reads them for the office, `technician-jobs` reads and writes them for the technician. Technician routes live under `/my-jobs/:jobId/work-photos`, staff ones under `/jobs/:jobId/work-photos`, so the homeowner's booking photos keep their existing paths on both sides. The two changing routes answer with the refreshed job page, like the status and repair routes.

**Tech Stack:** relay-api: Express 5, Drizzle ORM, PostgreSQL 18, Zod, Vitest + Supertest. relay-web: React 19, TanStack Query, Zod, Tailwind v4, shadcn/ui (Base UI), Vitest.

**Spec:** `relay-api/docs/superpowers/specs/2026-10-03-technician-job-photos-design.md`

## Global Constraints

- Two separate git repos side by side: `relay-api` and `relay-web`. Work on branch `feat/technician-job-photos` in both.
- Lean, plain code a junior developer can debug without AI. Match the surrounding comment style (short "why" comments above functions).
- Commit messages: lowercase conventional style like the history (`feat: …`, `docs: …`). No `Co-Authored-By` trailer.
- Run Biome only on the files you touched: `npx biome check --write <paths>`. Working copies use CRLF; Biome rewrites touched files to LF, which git normalizes.
- Limits: at most `6` photos per stage per job; at most `1024 * 1024` bytes each; browser shrinks to `1600` px longest side, JPEG quality `0.8`; `express.raw` body limit `2mb`.
- Photos change only while the job is `in_progress`. The page shows them in every status.
- Exact copy:
  - `Pick a JPEG, PNG or WebP photo.` (422 `not_a_photo`)
  - `That photo is too large. Pick a smaller one.` (413 `photo_too_large`)
  - `You can add up to 6 before photos.` / `You can add up to 6 after photos.` (409 `too_many_photos`)
  - `Start the visit before adding photos.` (422 `photos_not_open`, status `booked` or `en_route`)
  - `This visit is finished, so its photos can’t change.` (422 `photos_closed`, status `done` or `no_access`)
  - `That photo isn’t on this job.` (404, image route)
  - `That photo stage isn’t valid` (400, bad `:stage`)
  - `That photo link isn’t valid` (400, bad photo id — already in `JobPhotoParams`)
  - Technician card title `Your photos`; office drawer section title `Technician photos`; group titles `Before` and `After`; button `Take or choose a photo`
  - Empty, finished visit: `No photos were taken.`
  - Upload failure (network): `We couldn’t add this photo. Try again.`; remove failure toast: `We couldn’t remove that photo. Try again.`
  - Alt text `Before shot 1` / `After shot 1` (2, 3 …)
- Schema rules (top of `relay-api/src/db/schema.ts`): tenant tables reference parents by `(tenant_id, x_id)`; fixed value sets are text + a check built from one exported list; no cascades.

## Files

relay-api:
- Modify `src/db/schema.ts`: `jobPhotos` gains `contentType` and `data`, loses `storageKey`; new `JOB_PHOTO_MAX_BYTES` and `MAX_JOB_PHOTOS_PER_STAGE`.
- Create `drizzle/0010_technician_job_photos.sql` and `drizzle/meta/0010_snapshot.json` (both generated).
- Modify `src/modules/dispatch/dispatch.queries.ts`: four `job_photos` queries, read by both modules.
- Modify `src/modules/dispatch/dispatch.service.ts`: `workPhotos` in the job detail, `getWorkPhoto` for staff.
- Modify `src/modules/dispatch/dispatch.routes.ts`: `GET /jobs/:jobId/work-photos/:photoId`.
- Modify `src/modules/dispatch/dispatch.test.ts`: the office's two reads.
- Modify `src/modules/technician-jobs/technician-jobs.service.ts`: `workPhotos` in the job page, add/remove/serve.
- Modify `src/modules/technician-jobs/technician-jobs.schemas.ts`: `WorkPhotoStageParams`.
- Modify `src/modules/technician-jobs/technician-jobs.routes.ts`: three routes, raw body.
- Create `src/modules/technician-jobs/job-photos.test.ts`.

relay-web:
- Create `src/lib/photo.ts` + `src/lib/photo.test.ts` (moved from `src/features/booking/photo.ts` + `photo.test.ts`, with `PhotoError` moved in from `src/features/team/photo.ts`).
- Delete `src/features/booking/photo.ts` and `src/features/booking/photo.test.ts`.
- Modify `src/features/team/photo.ts`, `src/features/booking/photo-card.tsx`: import from `@/lib/photo`.
- Create `src/features/technician-jobs/job-photos.ts` + `job-photos.test.ts`: `photoGroups(status)`.
- Create `src/features/technician-jobs/job-photos.tsx`: the "Your photos" card.
- Modify `src/features/technician-jobs/api.ts`: `workPhotos` in `MyJob`, `useAddJobPhoto`, `useRemoveJobPhoto`.
- Modify `src/features/technician-jobs/job-details.tsx`: render the card.
- Modify `src/features/dispatch/api.ts`: `workPhotos` in `JobDetail`.
- Modify `src/features/dispatch/job-drawer.tsx`: the "Technician photos" section.

---

### Task 1: Branches and docs

**Files:**
- Commit: `relay-api/docs/superpowers/specs/2026-10-03-technician-job-photos-design.md`, `relay-api/docs/superpowers/plans/2026-10-03-technician-job-photos.md`

**Interfaces:**
- Produces: branch `feat/technician-job-photos` in both repos.

- [ ] **Step 1: Branch both repos and commit the docs**

```bash
cd relay-api
git switch -c feat/technician-job-photos
git add docs/superpowers/specs/2026-10-03-technician-job-photos-design.md docs/superpowers/plans/2026-10-03-technician-job-photos.md
git commit -m "docs: add the technician job photos spec and plan"
cd ../relay-web
git switch -c feat/technician-job-photos
```

Expected: `git status --short` clean in relay-api.

---

### Task 2: API — reshape `job_photos`

**Files:**
- Modify: `relay-api/src/db/schema.ts` (`PHOTO_STAGES` and `jobPhotos`, around lines 702–729)
- Create: `relay-api/drizzle/0010_technician_job_photos.sql` (generated)

**Interfaces:**
- Produces: `jobPhotos` with `contentType` + `data`, `JOB_PHOTO_MAX_BYTES`, `MAX_JOB_PHOTOS_PER_STAGE`.
- Consumes: `PROFILE_PHOTO_TYPES`, `bytea`, `oneOf` (all already in `schema.ts`).

- [ ] **Step 1: Change the table**

Replace the `jobPhotos` block. `storage_key` goes; the two new columns copy `booking_photos`, so
all three photo tables read the same way.

```ts
export const PHOTO_STAGES = ['before', 'after'] as const
export const JOB_PHOTO_MAX_BYTES = 1024 * 1024
// Per stage, per job: enough for a unit, its label and the finished work.
export const MAX_JOB_PHOTOS_PER_STAGE = 6

export const jobPhotos = pgTable(
  'job_photos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    jobId: uuid('job_id').notNull(),
    stage: text('stage', { enum: PHOTO_STAGES }).notNull(),
    // Read from the bytes on upload, never from the upload's header. Same list as profile photos.
    contentType: text('content_type', { enum: PROFILE_PHOTO_TYPES }).notNull(),
    data: bytea('data').notNull(),
    uploadedBy: uuid('uploaded_by').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'job_photos_job_fk',
      columns: [t.tenantId, t.jobId],
      foreignColumns: [jobs.tenantId, jobs.id],
    }),
    foreignKey({
      name: 'job_photos_uploaded_by_fk',
      columns: [t.tenantId, t.uploadedBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    check('job_photos_stage_valid', oneOf(t.stage, PHOTO_STAGES)),
    check('job_photos_content_type_valid', oneOf(t.contentType, PROFILE_PHOTO_TYPES)),
    check(
      'job_photos_size',
      sql`octet_length(${t.data}) between 1 and ${sql.raw(String(JOB_PHOTO_MAX_BYTES))}`,
    ),
    index('job_photos_job_idx').on(t.tenantId, t.jobId),
  ],
)
```

- [ ] **Step 2: Generate and run the migration**

```bash
cd relay-api
npm run db:generate -- --name technician_job_photos
npm run db:migrate
```

Check the generated SQL does only this: `ALTER TABLE "job_photos" DROP COLUMN "storage_key"`, add
`content_type` and `data` (both `not null`, no default — the table is empty), add the two new
checks. If drizzle-kit asks about renaming a column, answer that these are new columns.

Expected: `npm run typecheck` passes; `psql -d relay -c '\d job_photos'` shows the new shape.

---

### Task 3: API — the three technician routes

**Files:**
- Modify: `relay-api/src/modules/dispatch/dispatch.queries.ts`
- Modify: `relay-api/src/modules/technician-jobs/technician-jobs.service.ts`
- Modify: `relay-api/src/modules/technician-jobs/technician-jobs.schemas.ts`
- Modify: `relay-api/src/modules/technician-jobs/technician-jobs.routes.ts`
- Test: `relay-api/src/modules/technician-jobs/job-photos.test.ts`

**Interfaces:**
- Consumes: `photoTypeOf` (`src/lib/image-type.ts`), `sendPhoto` (`src/lib/send-photo.ts`), `dispatchQueries.lockJob`, `findMyJob`, `JobPhotoParams`.
- Produces:
  - Queries in `dispatch.queries.ts`, used by this task and Task 4: `listWorkPhotos(tenantId, jobId, tx?)`, `insertWorkPhoto(tenantId, values, tx?)`, `findWorkPhoto(tenantId, jobId, photoId)`, `deleteWorkPhoto(tenantId, jobId, photoId, tx?)`.
  - Service: `addWorkPhoto(user, jobId, stage, body)`, `removeWorkPhoto(user, jobId, photoId)`, `getWorkPhoto(user, jobId, photoId)`; `workPhotos` in `getMyJob`.
  - Routes: `POST /api/my-jobs/:jobId/work-photos/:stage`, `GET|DELETE /api/my-jobs/:jobId/work-photos/:photoId`.
  - `WorkPhotoStageParams` (schemas).

- [ ] **Step 1: Write the failing tests**

Create `relay-api/src/modules/technician-jobs/job-photos.test.ts`, modelled on
`booking-photos.test.ts` and `job-actions.test.ts`. Setup helper:

```ts
// A technician standing at the unit with the visit started.
async function startedJob(status: JobStatus = 'in_progress') {
  const shop = await createShop('desert')
  const tech = await createTechnician(shop.tenant.id, 'Luis Ortega')
  const job = await createJob(shop, { technicianId: tech.id, status })
  const cookie = await signInTechnician(tech)
  return { shop, tech, job, cookie }
}

function upload(cookie: string, jobId: string, stage: string, photo = PNG) {
  return request(app)
    .post(`/api/my-jobs/${jobId}/work-photos/${stage}`)
    .set('Cookie', cookie)
    .set('Content-Type', 'image/jpeg') // the claim is ignored; the bytes decide
    .send(photo)
}
```

Cover, in this order:

1. a before photo uploads: `201`, and the body is the refreshed job page with
   `workPhotos.before = [{ id, url: '/my-jobs/<jobId>/work-photos/<id>' }]` and
   `workPhotos.after = []`;
2. the image route serves the same bytes with `content-type` from the bytes (`image/png`),
   `x-content-type-options: nosniff`, `cache-control: private, max-age=31536000, immutable`;
3. the row has `stage = 'before'` and `uploaded_by` = the technician (read it back with Drizzle);
4. an after photo lands in `workPhotos.after`, and both groups come back oldest first;
5. a text buffer gets `422 not_a_photo`; `Buffer.alloc(JOB_PHOTO_MAX_BYTES + 1)` starting with the
   PNG signature gets `413 photo_too_large`;
6. a 7th before photo gets `409` "You can add up to 6 before photos.", while an after photo still
   uploads;
7. `stage = 'middle'` gets `400` "That photo stage isn’t valid";
8. uploading on a `booked` job gets `422 photos_not_open`; on a `done` job `422 photos_closed`;
9. another technician's job, and a job with `technicianId: null`, get `404` with `NOT_YOURS`; a
   staff session gets `403` (`requireRole('technician')`);
10. delete removes the photo (the refreshed page no longer lists it), deleting the same id twice is
    `200`, deleting a photo of another job is `404` "That photo isn’t on this job.", and deleting
    on a `done` job is `422 photos_closed`;
11. the homeowner's booking photo (helper copied from `technician-jobs.test.ts`) still appears
    under `photos` with its own `/my-jobs/<jobId>/photos/<id>` url, and is not in `workPhotos`.

Run `npx vitest run src/modules/technician-jobs/job-photos.test.ts`. Expected: red.

- [ ] **Step 2: Queries**

Add to `dispatch.queries.ts` (import `jobPhotos`), under the booking-photo queries it already has.
They live here because the office reads the same rows in Task 4, and `technician-jobs` already
imports this file:

```ts
// The technician's own photos of a job, oldest first, with the stage they belong to.
export function listWorkPhotos(tenantId: string, jobId: string, tx: Db = db) {
  return tx
    .select({ id: jobPhotos.id, stage: jobPhotos.stage })
    .from(jobPhotos)
    .where(and(eq(jobPhotos.tenantId, tenantId), eq(jobPhotos.jobId, jobId)))
    .orderBy(asc(jobPhotos.createdAt))
}

export async function insertWorkPhoto(
  tenantId: string,
  values: Pick<
    typeof jobPhotos.$inferInsert,
    'jobId' | 'stage' | 'contentType' | 'data' | 'uploadedBy'
  >,
  tx: Db = db,
) {
  const [photo] = await tx
    .insert(jobPhotos)
    .values({ tenantId, ...values })
    .returning({ id: jobPhotos.id })
  return photo
}

export async function findWorkPhoto(tenantId: string, jobId: string, photoId: string) {
  const [photo] = await db
    .select({ contentType: jobPhotos.contentType, data: jobPhotos.data })
    .from(jobPhotos)
    .where(
      and(
        eq(jobPhotos.tenantId, tenantId),
        eq(jobPhotos.jobId, jobId),
        eq(jobPhotos.id, photoId),
      ),
    )
  return photo
}

export function deleteWorkPhoto(tenantId: string, jobId: string, photoId: string, tx: Db = db) {
  return tx
    .delete(jobPhotos)
    .where(
      and(
        eq(jobPhotos.tenantId, tenantId),
        eq(jobPhotos.jobId, jobId),
        eq(jobPhotos.id, photoId),
      ),
    )
}
```

- [ ] **Step 3: Service**

In `technician-jobs.service.ts`:

```ts
// A technician photo as the page gets it. `url` is a path under the API, like the homeowner's;
// the web app puts the API's address in front.
function workPhotoLink(jobId: string, photoId: string) {
  return { id: photoId, url: `/my-jobs/${jobId}/work-photos/${photoId}` }
}

// Photos change only while the technician is at the unit with the visit started. Before that
// there is nothing to photograph; after it the visit is a finished record.
function checkPhotosOpen(status: string) {
  if (status === 'in_progress') return
  if (status === 'booked' || status === 'en_route') {
    throw new HttpError(422, 'photos_not_open', 'Start the visit before adding photos.')
  }
  throw new HttpError(422, 'photos_closed', 'This visit is finished, so its photos can’t change.')
}
```

`getMyJob` adds `dispatchQueries.listWorkPhotos(tenantId, jobId)` to its `Promise.all` and one field
beside `photos`:

```ts
workPhotos: {
  before: workPhotos.filter((p) => p.stage === 'before').map((p) => workPhotoLink(jobId, p.id)),
  after: workPhotos.filter((p) => p.stage === 'after').map((p) => workPhotoLink(jobId, p.id)),
},
```

Add, next to `getMyJobPhoto`:

```ts
// A photo the technician takes on the visit. The bytes decide the type, and the job row is
// locked while counting, so two quick uploads can't both take the last place in a stage.
export async function addWorkPhoto(
  user: SessionUser,
  jobId: string,
  stage: PhotoStage,
  body: unknown,
) {
  const contentType = Buffer.isBuffer(body) ? photoTypeOf(body) : null
  if (!Buffer.isBuffer(body) || !contentType) {
    throw new HttpError(422, 'not_a_photo', 'Pick a JPEG, PNG or WebP photo.')
  }
  if (body.length > JOB_PHOTO_MAX_BYTES) {
    throw new HttpError(413, 'photo_too_large', 'That photo is too large. Pick a smaller one.')
  }
  await findMyJob(user, jobId)
  const tenantId = tenantOf(user)
  await db.transaction(async (tx) => {
    const job = await dispatchQueries.lockJob(tenantId, jobId, tx)
    if (!job || job.technicianId !== user.id) throw notYours()
    checkPhotosOpen(job.status)
    const photos = await dispatchQueries.listWorkPhotos(tenantId, jobId, tx)
    if (photos.filter((photo) => photo.stage === stage).length >= MAX_JOB_PHOTOS_PER_STAGE) {
      throw new HttpError(
        409,
        'too_many_photos',
        `You can add up to ${MAX_JOB_PHOTOS_PER_STAGE} ${stage} photos.`,
      )
    }
    await dispatchQueries.insertWorkPhoto(
      tenantId,
      { jobId, stage, contentType, data: body, uploadedBy: user.id },
      tx,
    )
  })
  return getMyJob(user, jobId)
}

// Removing a photo that is already gone is harmless.
export async function removeWorkPhoto(user: SessionUser, jobId: string, photoId: string) {
  await findMyJob(user, jobId)
  const tenantId = tenantOf(user)
  await db.transaction(async (tx) => {
    const job = await dispatchQueries.lockJob(tenantId, jobId, tx)
    if (!job || job.technicianId !== user.id) throw notYours()
    checkPhotosOpen(job.status)
    await dispatchQueries.deleteWorkPhoto(tenantId, jobId, photoId, tx)
  })
  return getMyJob(user, jobId)
}

export async function getWorkPhoto(user: SessionUser, jobId: string, photoId: string) {
  await findMyJob(user, jobId)
  const photo = await dispatchQueries.findWorkPhoto(tenantOf(user), jobId, photoId)
  if (!photo) throw new HttpError(404, 'not_found', 'That photo isn’t on this job.')
  return photo
}
```

`PhotoStage` is `(typeof PHOTO_STAGES)[number]`, imported from `src/db/schema.ts` with
`JOB_PHOTO_MAX_BYTES` and `MAX_JOB_PHOTOS_PER_STAGE`. Update the module's header comment: photos
are no longer "a later part of module 8".

- [ ] **Step 4: Schema and routes**

`technician-jobs.schemas.ts`:

```ts
export const WorkPhotoStageParams = JobParams.extend({
  stage: z.enum(PHOTO_STAGES, 'That photo stage isn’t valid'),
})
```

`technician-jobs.routes.ts` — the raw body comes first, like `team.routes.ts`:

```ts
// A photo is the request body itself, not JSON. The service refuses anything that isn't a
// small JPEG, PNG or WebP, whatever the upload says it is.
const photoBody = express.raw({ type: () => true, limit: '2mb' })

technicianJobsRoutes.post(
  '/my-jobs/:jobId/work-photos/:stage',
  technician,
  photoBody,
  async (req, res) => {
    const { jobId, stage } = WorkPhotoStageParams.parse(req.params)
    res.status(201).json(await technicianJobs.addWorkPhoto(req.user!, jobId, stage, req.body))
  },
)

technicianJobsRoutes.get('/my-jobs/:jobId/work-photos/:photoId', technician, async (req, res) => {
  const { jobId, photoId } = JobPhotoParams.parse(req.params)
  sendPhoto(res, await technicianJobs.getWorkPhoto(req.user!, jobId, photoId))
})

technicianJobsRoutes.delete(
  '/my-jobs/:jobId/work-photos/:photoId',
  technician,
  async (req, res) => {
    const { jobId, photoId } = JobPhotoParams.parse(req.params)
    res.json(await technicianJobs.removeWorkPhoto(req.user!, jobId, photoId))
  },
)
```

Put them after the existing `/photos/:photoId` route so the file still reads page, photos, then
buttons. No rate limit: these routes need a technician session, unlike the public booking ones.

- [ ] **Step 5: Green and clean**

```bash
npx vitest run src/modules/technician-jobs
npm run typecheck
npx biome check --write src/db/schema.ts src/modules/technician-jobs
git add -A && git commit -m "feat: let a technician add before and after photos to a job"
```

Expected: the whole `technician-jobs` suite green, including the untouched tests.

---

### Task 4: API — the office's read

**Files:**
- Modify: `relay-api/src/modules/dispatch/dispatch.service.ts` (`getJob` around line 63, `getJobPhoto` around line 91)
- Modify: `relay-api/src/modules/dispatch/dispatch.routes.ts` (after the `/jobs/:jobId/photos/:photoId` route, line 29)
- Test: `relay-api/src/modules/dispatch/dispatch.test.ts`

**Interfaces:**
- Consumes: `dispatchQueries.listWorkPhotos`, `dispatchQueries.findWorkPhoto` (Task 3), `sendPhoto`, `JobPhotoParams`.
- Produces: `workPhotos` on `GET /api/jobs/:jobId`; `GET /api/jobs/:jobId/work-photos/:photoId`; `dispatch.getWorkPhoto(tenantId, jobId, photoId)`.

The office only looks: no upload and no delete. The technician who stood at the unit is the only
one who changes these rows.

- [ ] **Step 1: Write the failing tests**

In `dispatch.test.ts`, beside the existing booking-photo tests, insert `job_photos` rows straight
with Drizzle (no technician session needed — a small helper like `addBookingPhoto`):

```ts
// A photo the technician took on this visit.
async function addWorkPhoto(shop: Shop, jobId: string, techId: string, stage: 'before' | 'after') {
  const [photo] = await db
    .insert(jobPhotos)
    .values({
      tenantId: shop.tenant.id,
      jobId,
      stage,
      contentType: 'image/jpeg',
      data: JPEG,
      uploadedBy: techId,
    })
    .returning()
  return photo
}
```

Cover:

1. `GET /jobs/:jobId` returns `workPhotos.before` and `workPhotos.after` with
   `url: '/jobs/<jobId>/work-photos/<id>'`, oldest first, and still returns the homeowner's
   `photos` separately;
2. a job with none answers `{ before: [], after: [] }`;
3. the image route serves the bytes with `content-type`, `nosniff` and the long `cache-control`;
4. a photo of another job gets `404` "That photo isn’t on this job.";
5. another contractor's job gets the usual `404`;
6. no session gets `401`, and a technician's session gets `403` (`requireRole('owner', 'office')`).

- [ ] **Step 2: Service**

In `getJob`, add `queries.listWorkPhotos(tenantId, jobId)` to the `Promise.all` and one field
beside `photos`:

```ts
// The technician's own shots of the visit, by stage. The office only looks at these.
workPhotos: {
  before: workPhotos
    .filter((photo) => photo.stage === 'before')
    .map((photo) => ({ id: photo.id, url: `/jobs/${jobId}/work-photos/${photo.id}` })),
  after: workPhotos
    .filter((photo) => photo.stage === 'after')
    .map((photo) => ({ id: photo.id, url: `/jobs/${jobId}/work-photos/${photo.id}` })),
},
```

Pull the url out into a local helper if the repetition reads badly, the same way
`technician-jobs.service.ts` has `workPhotoLink`.

```ts
// A photo the technician took on this visit.
export async function getWorkPhoto(tenantId: string, jobId: string, photoId: string) {
  const photo = await queries.findWorkPhoto(tenantId, jobId, photoId)
  if (!photo) throw new HttpError(404, 'not_found', 'That photo isn’t on this job.')
  return photo
}
```

- [ ] **Step 3: Route**

```ts
dispatchRoutes.get('/jobs/:jobId/work-photos/:photoId', staff, async (req, res) => {
  const { jobId, photoId } = JobPhotoParams.parse(req.params)
  sendPhoto(res, await dispatch.getWorkPhoto(tenantOf(req.user!), jobId, photoId))
})
```

- [ ] **Step 4: Green and clean**

```bash
npx vitest run src/modules/dispatch src/modules/technician-jobs
npm run typecheck
npx biome check --write src/modules/dispatch
git add -A && git commit -m "feat: show the technician's job photos to the office"
```

Expected: both suites green.

---

### Task 5: Web — move the photo helper to `lib`

**Files:**
- Create: `relay-web/src/lib/photo.ts`, `relay-web/src/lib/photo.test.ts`
- Delete: `relay-web/src/features/booking/photo.ts`, `relay-web/src/features/booking/photo.test.ts`
- Modify: `relay-web/src/features/team/photo.ts`, `relay-web/src/features/booking/photo-card.tsx`

**Interfaces:**
- Produces: `PhotoError`, `fitWithin(width, height, max)`, `shrinkPhoto(file): Promise<Blob>` from `@/lib/photo`.

**Why:** the technician page needs the same shrinking as the booking wizard. Without the move it
would import `@/features/booking/photo`, a dependency between two features. `lib` is where the
shared pure helpers live.

- [ ] **Step 1: Move the files**

```bash
cd relay-web
git mv src/features/booking/photo.ts src/lib/photo.ts
git mv src/features/booking/photo.test.ts src/lib/photo.test.ts
```

Move `PhotoError` out of `src/features/team/photo.ts` into `src/lib/photo.ts` (top of the file,
comment kept), drop the now-unused import at the top of `src/lib/photo.ts`, and make
`src/features/team/photo.ts` import and re-export nothing — it imports `PhotoError` from
`@/lib/photo` for `preparePhoto`.

- [ ] **Step 2: Fix the importers**

- `src/features/booking/photo-card.tsx`: `import { PhotoError } from '@/lib/photo'` and
  `import { shrinkPhoto } from '@/lib/photo'` (one import line).
- `src/features/team/technician-dialog.tsx` and any other file importing `PhotoError` or
  `preparePhoto`: check with `grep -rn "features/team/photo'\|features/booking/photo'" src`.
- `src/lib/photo.test.ts`: import path becomes `./photo`.

```bash
npx vitest run src/lib/photo.test.ts src/features/team
npx tsc --noEmit
npx biome check --write src/lib/photo.ts src/lib/photo.test.ts src/features/team/photo.ts src/features/booking/photo-card.tsx
git add -A && git commit -m "refactor: move the photo shrinking helper to lib"
```

Expected: green, and `grep -rn "features/booking/photo'" src` finds nothing.

---

### Task 6: Web — API hooks and the group rule

**Files:**
- Modify: `relay-web/src/features/technician-jobs/api.ts`
- Create: `relay-web/src/features/technician-jobs/job-photos.ts`, `job-photos.test.ts`

**Interfaces:**
- Produces: `workPhotos` on `MyJob`; `useAddJobPhoto(jobId)`, `useRemoveJobPhoto(jobId)`; `photoGroups(status)`.

- [ ] **Step 1: `MyJob` gains `workPhotos`**

The existing `photos` array already transforms its `url`; reuse that shape:

```ts
// `url` arrives as a path under the API; made loadable here, like other photos.
const JobPhoto = z.object({
  id: z.string(),
  url: z.string().transform((path) => `${env.VITE_API_URL}${path}`),
})
export type JobPhoto = z.infer<typeof JobPhoto>
```

Use it for `photos` and add `workPhotos: z.object({ before: z.array(JobPhoto), after: z.array(JobPhoto) })`.

- [ ] **Step 2: The two hooks**

Both answer with the refreshed job page, so they follow `useRepairAction`:

```ts
// `photo` is already shrunk (lib/photo.ts). Both calls answer with the refreshed job page.
export function useAddJobPhoto(jobId: string) {
  const queryClient = useQueryClient()
  const jobKey = [...myJobsKey, 'job', jobId]
  return useMutation({
    mutationFn: ({ stage, photo }: { stage: 'before' | 'after'; photo: Blob }) =>
      api.post(`/my-jobs/${jobId}/work-photos/${stage}`, photo, MyJob),
    onSuccess: (detail) => queryClient.setQueryData(jobKey, detail),
    // The job changed under the technician (reassigned, completed by the office): show it as it is.
    onError: () => queryClient.invalidateQueries({ queryKey: jobKey }),
  })
}

export function useRemoveJobPhoto(jobId: string) { /* api.delete(`…/work-photos/${photoId}`, MyJob) */ }
```

- [ ] **Step 3: `photoRules`, with a test**

```ts
import type { JobStatus } from '@/features/dispatch/api'

// The photo card on a technician's job: hidden before the visit starts, open while it is in
// progress, and a read-only record once it is finished. Matches the API's own rule. The
// statuses a technician never sees ('held', 'expired', 'cancelled') show nothing.
export function photoGroups(status: JobStatus): { show: boolean; canChange: boolean } {
  if (status === 'in_progress') return { show: true, canChange: true }
  if (status === 'done' || status === 'no_access') return { show: true, canChange: false }
  return { show: false, canChange: false }
}
```

Test every status in `JOB_STATUSES`, like `next-step.test.ts` does.

```bash
npx vitest run src/features/technician-jobs
npx tsc --noEmit
```

Expected: `tsc` fails only in `job-details.tsx` until Task 7 renders the card (the new `MyJob`
field is additive, so it should in fact pass).

---

### Task 7: Web — the "Your photos" card

**Files:**
- Create: `relay-web/src/features/technician-jobs/job-photos.tsx`
- Modify: `relay-web/src/features/technician-jobs/job-details.tsx`

**Interfaces:**
- Consumes: `photoRules`, `useAddJobPhoto`, `useRemoveJobPhoto`, `shrinkPhoto`, `PhotoError`, `MyJob`.
- Produces: `<JobPhotos job={job} workPhotos={workPhotos} />`.

- [ ] **Step 1: The card**

Model it on `src/features/booking/photo-card.tsx`: the same one-file-at-a-time upload loop, the
same dimmed-thumbnail-with-spinner while a photo is on its way, the same error handling. Two
groups in one card, each rendered by a small inner component:

```tsx
const MAX_PER_STAGE = 6 // relay-api's MAX_JOB_PHOTOS_PER_STAGE
const UPLOAD_FAILED = 'We couldn’t add this photo. Try again.'

const STAGE_LABELS = { before: 'Before', after: 'After' } as const
```

- Card: `<section>` styled like the other cards on the page (`rounded-3xl bg-card p-3 shadow-sm`),
  heading `Your photos`, then the two groups.
- Each group: the label, a `grid grid-cols-3 gap-3` of square thumbnails, then the button when
  `canChange` and there is room. Each thumbnail is an `<a target="_blank" rel="noreferrer">`
  around the `<img>`, with the ✕ button on top when `canChange`, exactly like the booking card.
- `canChange === false` and both groups empty: one line, `No photos were taken.`
- Errors: `setError` per card (one message is enough), `toast.error` for a failed removal.
- Keep the file under about 150 lines; two tiny components beat one big one.

- [ ] **Step 2: Wire it into the page**

In `job-details.tsx`, `JobInfo` destructures `workPhotos` and renders the card between the notes
row and the Charges block, behind `photoGroups(job.status).show`. Nothing else on the page moves.

- [ ] **Step 3: Check it in a browser**

Headless Edge over the DevTools protocol (`--headless=new --inprivate`, new tab via
`PUT /json/new`), signed in as the demo technician with a `sign_in_codes` row whose `code_hash`
is HMAC-SHA256 of a known code — see the session memory note. Drive one `desert` job to
`in_progress` and take screenshots at phone width (390 px):

1. the card with both groups empty,
2. two before photos uploaded,
3. before and after photos, then the job completed (card read-only).

Say in the write-up which job was used: driving the flow changes the dev database (statuses,
rows in `messages`).

```bash
npx vitest run
npx tsc --noEmit
npx biome check --write src/features/technician-jobs
git add -A && git commit -m "feat: show before and after photos on the technician job page"
```

Expected: the whole web suite green.

---

### Task 8: Web — the office drawer

**Files:**
- Modify: `relay-web/src/features/dispatch/api.ts` (`JobDetail`, `photos` around line 105)
- Modify: `relay-web/src/features/dispatch/job-drawer.tsx` (`JobDetails`, the Problem section around line 118)

**Interfaces:**
- Consumes: `workPhotos` from `GET /jobs/:jobId` (Task 4).
- Produces: the "Technician photos" section in the drawer.

- [ ] **Step 1: `JobDetail` gains `workPhotos`**

Same shape as the technician's, built on the schema the drawer's `photos` already uses — pull it
out into a named `JobPhoto` schema first so both fields share it:

```ts
// The technician's own shots of the visit. `url` arrives as a path under the API.
workPhotos: z.object({ before: z.array(JobPhoto), after: z.array(JobPhoto) }),
```

- [ ] **Step 2: The section**

In `JobDetails`, destructure `workPhotos` and add a section between Problem and Charges, hidden
when both groups are empty. The thumbnails are the markup the homeowner's photos already use in
this file (link, `target="_blank"`, `rel="noreferrer"`, `size-20 rounded-lg object-cover`), so
lift that list into one small local component and call it three times:

```tsx
// Thumbnails that open the full photo in a new tab. `label` names them for screen readers:
// 'Homeowner’s upload', 'Before photo', 'After photo'.
function PhotoRow({ photos, label }: { photos: JobPhoto[]; label: string }) { … }
```

```tsx
{(workPhotos.before.length > 0 || workPhotos.after.length > 0) && (
  <section className="space-y-1 text-sm">
    <h3 className="font-medium">Technician photos</h3>
    {workPhotos.before.length > 0 && (
      <>
        <p className="text-muted-foreground">Before</p>
        <PhotoRow photos={workPhotos.before} label="Before shot" />
      </>
    )}
    {/* the same for After */}
  </section>
)}
```

No buttons: the office doesn't add or remove these.

- [ ] **Step 3: Check it in a browser**

The same headless Edge run as Task 7, continued: sign in as the owner on `desert.localhost`, open
the board, open the job the technician photographed, and screenshot the drawer with both groups.
Check one thumbnail opens the full photo.

```bash
npx vitest run
npx tsc --noEmit
npx biome check --write src/features/dispatch
git add -A && git commit -m "feat: show the technician's job photos in the office drawer"
```

Expected: the whole web suite green, and the drawer unchanged for jobs without these photos.

---

### Task 9: Wrap up

- [ ] **Step 1: Full check in both repos**

```bash
cd relay-api && npm test && npm run typecheck && npm run lint
cd ../relay-web && npx vitest run && npx tsc --noEmit && npm run lint
```

- [ ] **Step 2: Mark the spec approved and note what is left**

Set the spec's `Status:` to `approved`. What stays out, in case it comes up next: photo counts or
thumbnails on the board cards, the homeowner ever seeing these photos, and the office being able
to remove one.

Expected: both repos green, both branches ready to merge.
