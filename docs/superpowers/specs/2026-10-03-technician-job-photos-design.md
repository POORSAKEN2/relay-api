# Technician job photos: before and after shots on the visit

Date: 2026-10-03. Status: draft. Plan: `docs/superpowers/plans/2026-10-03-technician-job-photos.md`.

## Problem

The technician job page shows only the photos the homeowner added while booking. Nothing records
what the technician found at the unit, or what it looked like once the repair was done. The
office has no proof of the work, and a homeowner who asks later gets nothing.

`job_photos` was created in migration `0001` for exactly this, with `stage in ('before',
'after')`, but nothing reads or writes it and its `storage_key` column points at file storage
the project doesn't have.

## Goal

1. While a visit is in progress, the technician can add photos in two groups: **Before** (what
   they found at diagnosis) and **After** (the finished repair).
2. The photos are stored in `job_photos` with `stage = 'before'` or `'after'` and the uploading
   technician in `uploaded_by`.
3. The job page shows both groups, each thumbnail opening the full photo, with an ✕ to remove one
   while the visit is still in progress.
4. The office sees the same two groups in the dispatch job drawer, read-only.
5. The homeowner's booking photos keep their own place on both pages and are never mixed in.

## Out of scope

- Showing them to the homeowner (no homeowner-facing job page exists).
- The office adding or removing a technician's photos. Only the technician who is at the unit
  changes them; the drawer only looks.
- Photo counts or thumbnails on the board cards.
- Blocking "Job complete" on an after photo. A technician can finish a visit without photos.
- File storage (S3, R2). Photos go in Postgres like the other two photo tables.
- Captions, ordering by hand, or replacing one photo with another.

## Data: reshape `job_photos`

`job_photos` is empty in every database (nothing writes it), so migration `0010` changes it in
place with no data to move. It becomes the same shape as `user_photos` and `booking_photos`.

| Column | Meaning |
| --- | --- |
| `id`, `tenant_id`, `job_id` | Unchanged. Foreign key `(tenant_id, job_id)` to `jobs`. |
| `stage` | `'before'` or `'after'` (`PHOTO_STAGES`). Unchanged, check kept. |
| `uploaded_by` | The technician. Foreign key `(tenant_id, uploaded_by)` to `users`. Unchanged. |
| `content_type` | **New.** `image/jpeg`, `image/png` or `image/webp`, read from the bytes with `photoTypeOf`, never from the upload's header. `PROFILE_PHOTO_TYPES`, like the other two tables. |
| `data` | **New.** The photo bytes (`bytea`). A check keeps it between 1 byte and 1 MB. |
| `storage_key` | **Dropped.** The file storage it was kept for is not part of the MVP. |
| `created_at` | Unchanged. Both groups show oldest first. |

Rules:

- At most `6` photos per stage per job (`MAX_JOB_PHOTOS_PER_STAGE`). Checked by the service while
  the job row is locked, not by the database.
- At most `1 MB` per photo (`JOB_PHOTO_MAX_BYTES`), the same limit as a booking photo. The browser
  shrinks to 1600 px on the longest side first, so a phone photo lands near 300–500 KB.
- The existing index `job_photos_job_idx (tenant_id, job_id)` already covers the page's read.

## When photos can change

Uploads and removals are allowed only while the job is `in_progress`: the technician is at the
unit with the visit started. Both stages use the same rule, because both shots are taken during
the same visit.

- `booked` or `en_route`: `422 photos_not_open`, "Start the visit before adding photos."
- `done` or `no_access`: `422 photos_closed`, "This visit is finished, so its photos can’t change."

The job page still *shows* the photos in every status, so a technician who reopens a finished job
can look at what they took.

## Queries live in `modules/dispatch`

Both sides read the same table, and `technician-jobs` already depends on `dispatch` (never the
other way), so the four `job_photos` queries go in `dispatch.queries.ts` next to the booking-photo
ones. `dispatch` reads them for the office; `technician-jobs` reads and writes them for the
technician. No new dependency in either direction.

## API: technician (`modules/technician-jobs`)

Every route is `requireRole('technician')` and goes through `findMyJob`, so a job that isn't
theirs answers the same `404` "This job isn’t assigned to you anymore." as the rest of the module.

The homeowner's booking photos keep `GET /my-jobs/:jobId/photos/:photoId`. The technician's own
photos live under `work-photos`, so the two never collide:

- `POST /my-jobs/:jobId/work-photos/:stage` takes the photo as the raw request body, like
  technician profile photos and booking photos (`express.raw`, 2 MB limit). `:stage` is `before`
  or `after`.
  - `422 not_a_photo` "Pick a JPEG, PNG or WebP photo." when the bytes aren't one of the three.
  - `413 photo_too_large` "That photo is too large. Pick a smaller one." over 1 MB.
  - `409 too_many_photos` "You can add up to 6 before photos." (or "after") when that stage is
    full. The job row is locked (`for update`) while counting, so two quick uploads can't both
    take the last place.
  - `400` for any other `:stage`; the message "That photo stage isn’t valid" is in `details.stage`, like every validation error.
- `DELETE /my-jobs/:jobId/work-photos/:photoId` removes one photo of this job. Removing one that
  is already gone is harmless.
- `GET /my-jobs/:jobId/work-photos/:photoId` returns the image with `Content-Type`,
  `X-Content-Type-Options: nosniff` and `Cache-Control: private, max-age=31536000, immutable`,
  through the shared `sendPhoto`. `404` "That photo isn’t on this job." when it belongs to
  another job.

The two changing routes answer with the refreshed job page (the same body as
`GET /my-jobs/:jobId`), like the status buttons and the repair routes, so the page needs no
second request.

`GET /my-jobs/:jobId` gains one field beside `photos`:

```json
"workPhotos": {
  "before": [{ "id": "...", "url": "/my-jobs/<jobId>/work-photos/<id>" }],
  "after": []
}
```

`url` is a path under the API, like every other photo in Relay; the web app puts the API's
address in front.

## API: office (`modules/dispatch`)

Read-only, `requireRole('owner', 'office')`, beside the booking-photo routes it already has:

- `GET /jobs/:jobId` gains the same `workPhotos: { before, after }` field, with urls under
  `/jobs/<jobId>/work-photos/<id>` (the staff path, not the technician's).
- `GET /jobs/:jobId/work-photos/:photoId` returns the image with the same three headers, through
  `sendPhoto`. `404` "That photo isn’t on this job." when it belongs to another job or another
  contractor.

Jobs without technician photos answer `{ before: [], after: [] }` and look as they do today.

## Job page (`relay-web/src/features/technician-jobs`)

A new card, "Your photos", below the office's notes and above Charges:

- Two groups, **Before** and **After**, each a grid of square thumbnails, oldest first, with a
  "Take or choose a photo" button while the group has room and the visit is in progress.
- The picker is a file input with `accept="image/*"` and `multiple`, so a phone offers the camera
  or the library. No `capture`, so the library stays available.
- Picking photos: each one is shrunk in the browser (1600 px longest side, JPEG 0.8, which also
  drops the phone's location data), shown at once as a dimmed thumbnail with a spinner, then
  replaced by the API's copy. Files upload one after another, so two uploads never race for the
  last free place. Files past the free places are ignored.
- Each thumbnail links to the full photo in a new tab (`rel="noreferrer"`) and carries an ✕ to
  remove it while the visit is in progress. Alt text "Before photo 1", "After photo 1".
- Before the visit starts (`booked`, `en_route`) the card is hidden: nothing to show, nothing to
  add. Once the visit is finished (`done`, `no_access`) the card shows what was taken, read-only,
  and says "No photos were taken." when both groups are empty.
- Upload failure shows the API's message, or "We couldn’t add this photo. Try again." for a
  network failure; the dimmed thumbnail goes away. A failed removal shows a toast, "We couldn’t
  remove that photo. Try again."

`shrinkPhoto` and `fitWithin` move from `src/features/booking/photo.ts` to `src/lib/photo.ts`,
together with `PhotoError` from `src/features/team/photo.ts`, so the booking wizard and the
technician page both depend on `lib` instead of on each other.

Which groups the card shows, and whether they take uploads, is one pure function
(`photoGroups(status)`) with a unit test, like `nextStep`.

## Office drawer (`relay-web/src/features/dispatch/job-drawer.tsx`)

A section "Technician photos" between Problem and Charges, hidden when both groups are empty:
a **Before** row and an **After** row of `size-20` thumbnails, the same markup the homeowner's
photos already use in the drawer (a link that opens the full photo in a new tab, `rel="noreferrer"`).
Alt text "Before photo 1", "After photo 1". No upload button and no ✕: the office only looks.

## Testing

- API (`vitest`, real Postgres, new `src/modules/technician-jobs/job-photos.test.ts`):
  - a before and an after photo upload, the refreshed page lists them under the right stage, and
    the image route serves the bytes with the three headers;
  - a text file gets `422`, a photo over 1 MB gets `413`, a 7th photo of one stage gets `409`
    while the other stage still takes one;
  - uploading while `booked` and while `done` gets `422`;
  - another technician's job, and an unassigned job, get `404`;
  - `uploaded_by` is the signed-in technician and `stage` is what the path asked for;
  - delete removes it, deleting twice is fine, deleting another job's photo is `404`, and
    deleting while `done` is `422`;
  - the booking-photo routes still answer as before (nothing mixed in).
- API (`dispatch.test.ts`): `GET /jobs/:jobId` lists both stages with staff urls; the staff image
  route serves the bytes; a photo of another job gets `404`; a technician's session gets `403` on
  the staff route, and a staff session gets `403` on the technician one.
- Web (`vitest`): `photoGroups` for each status; the moved `fitWithin` test keeps passing.
- By hand: headless Edge over the DevTools protocol, one job driven to `in_progress`, screenshots
  of the technician card (empty, with before photos, with both groups) at phone width, and of the
  office drawer showing the same photos.

## Order of work

1. API: schema and migration `0010`.
2. API: shared queries in `dispatch`, technician service, schemas, routes, tests.
3. API: office job detail and staff image route, tests.
4. Web: move the photo helper to `lib`.
5. Web: API schema and hooks, `photoGroups` and its test.
6. Web: the "Your photos" card, wired into the job page.
7. Web: the "Technician photos" section in the office drawer. Screenshots of both sides.
