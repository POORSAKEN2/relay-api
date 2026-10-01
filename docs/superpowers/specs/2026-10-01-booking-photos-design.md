# Booking photos: let homeowners show the unit when they don't know what it is

Date: 2026-10-01. Status: approved. Plan: `docs/superpowers/plans/2026-10-01-booking-photos.md`.

## Problem

On step 4 of the booking wizard, a homeowner who doesn't know their system picks "Not sure" or
"Other". The technician then arrives without knowing what unit to expect, which parts to bring,
or whether the job is what the homeowner described.

## Goal

1. After "Not sure" or "Other", step 4 offers to take or choose up to 3 photos of the unit.
2. Photos are optional and never block a booking, but the wizard nudges hard: a highlighted
   card, and one reminder the first time the homeowner continues without a photo.
3. Photos are saved with the draft as soon as they are picked, so a refresh or the resume link
   keeps them.
4. The office sees the photos in the job drawer on the dispatch board.

## Out of scope

- Photos on the technician job page (`/jobs/:token`). That page is still a placeholder; when the
  jobs module builds it, it needs its own job-link photo route.
- Photos for the other system types.
- Mentioning the photos in the step 6 summary.
- Moving photos to file storage (S3, R2 or similar). `job_photos.storage_key` is kept for that.

## Data: `booking_photos`

Photos are stored in Postgres, like technician photos (`user_photos`). The browser shrinks them
first, so each one is small. This needs no new service, keys or local setup. The cost is about
1.2 MB of database per booking with 3 photos, which is fine for the pilot.

| Column | Meaning |
| --- | --- |
| `id`, `tenant_id` | As everywhere: every query takes `tenantId` first. |
| `draft_id` | The draft the photo was added to. Foreign key `(tenant_id, draft_id)` to `booking_drafts`. No cascade: drafts are never deleted, and the schema rule is that only sessions and sign-in codes cascade. |
| `content_type` | `image/jpeg`, `image/png` or `image/webp`, read from the bytes with `photoTypeOf`, never from the upload's header. Same list as profile photos. |
| `data` | The photo bytes (`bytea`). A check keeps it between 1 byte and 1 MB. |
| `created_at` | As everywhere. |

Rules:

- At most 3 photos per draft (`MAX_BOOKING_PHOTOS`). Checked by the service, not the database.
- Photos stay linked to the draft. A booked job finds its photos through
  `booking_drafts.booked_job_id`, so nothing is copied or moved when the booking is made.
- Migration `0007` creates the table and its index on `(tenant_id, draft_id)`, and adds
  `unique (tenant_id, id)` to `booking_drafts` so the foreign key can include the tenant, like
  the other tenant-scoped keys.

## API: homeowner (`modules/online-booking`)

The draft token is the only key. Like the other draft routes, each answers `404` when the
token is unknown, belongs to another tenant, or its draft is already booked. All routes use
`tenantFromHost` except the image route: an `<img>` can't send `X-Tenant-Host`. Tokens are
unique across Relay, so the token alone still finds exactly one draft.

A photo is returned as `{ id, url }`. `url` is a path under the API, like a technician's
`photoUrl`; the web app puts the API's address in front.

- `POST /online-booking/drafts/:token/photos` takes the photo as the raw request body, like
  technician photos (`express.raw`, 2 MB limit), and returns `201 { photo: { id, url } }`.
  - `422 not_a_photo` "Pick a JPEG, PNG or WebP photo." when the bytes aren't one of the three.
  - `413 photo_too_large` "That photo is too large. Pick a smaller one." over 1 MB.
  - `409 too_many_photos` "You can add up to 3 photos." when the draft already has 3. The
    draft row is locked (`for update`) while counting, so two quick uploads can't both be the
    third.
  - Has its own rate limit, 30 uploads per 15 minutes per address, on top of the draft one.
- `GET /online-booking/drafts/:token/photos` returns `{ photos: [{ id, url }] }`, oldest first.
- `GET /online-booking/drafts/:token/photos/:photoId` returns the image with its
  `Content-Type`, `X-Content-Type-Options: nosniff` and
  `Cache-Control: private, max-age=31536000, immutable` (a photo's bytes never change).
- `DELETE /online-booking/drafts/:token/photos/:photoId` removes one photo. Removing one that is
  already gone is harmless.

Adding or removing a photo sets the draft's `last_activity_at`, like saving answers does, so the
recovery text waits for a homeowner who is still busy.

## API: staff (`modules/dispatch`)

- `GET /jobs/:jobId` also returns `photos: [{ id, url }]`: the photos of the draft whose
  `booked_job_id` is this job. Empty for jobs booked by the office or without photos.
- `GET /jobs/:jobId/photos/:photoId` returns the image to staff, with the same headers as above.
  `404` when the photo doesn't belong to that job.

## Cleanup job (`pg-boss`, daily, `booking-photo-cleanup`)

Every day at 3:30 AM UTC (pg-boss schedules in UTC) it deletes the photos of drafts that were never booked
(`booked_job_id is null`) and have had no activity for 30 days (`last_activity_at`). It logs
how many it deleted. The drafts themselves stay. Photos of booked jobs are never deleted.

## Wizard (`relay-web/src/features/booking`)

- `ProblemStep` gets the `draftToken`. Every homeowner on step 4 has one, because the contact
  step saves the draft before moving on.
- A photo card shows below "What kind of system?" when the system type is `not_sure` or
  `other`, or when the draft already has photos (so a homeowner who switches type can still see
  and remove them).
- The card: a camera icon, "Add a photo of your unit", "A photo of your unit and its label
  helps your technician bring the right parts.", on a light brand tint so it stands out from
  the plain cards. One button, "Take or choose a photo": a file input with `accept="image/*"`
  and `multiple`, which offers the camera or the photo library on phones. No `capture`, so the
  library stays available.
- Picking a photo:
  1. The browser shrinks it to 1600 px on the longest side and saves it as JPEG at 0.8
     quality (about 300 to 500 KB). Saving it again also drops the phone's location data.
     The size math is a small pure function with a unit test. A file the browser can't read
     shows `PhotoError`'s message.
  2. A thumbnail shows right away with a spinner while it uploads.
  3. When the upload is done, the list comes from the API (TanStack Query, refetched after
     each add or remove). Each thumbnail has an ✕ to remove it.
  - When more files are picked than there are free places, only the first ones are uploaded.
  - With 3 photos the button hides.
- The nudge: the first time the homeowner taps Continue while the card shows and has no
  photos, the step doesn't move on. The card scrolls into view, shakes once (no shake with
  reduced motion) and shows "A photo really helps. Add one, or tap Continue again to skip."
  The second tap continues.
- The thumbnails load from each photo's `url`, with the API base URL from `env.ts` in front.

## Office drawer (`relay-web/src/features/dispatch/job-drawer.tsx`)

The Problem section shows up to 3 thumbnails under the "System:" line, each a link that opens
the full photo in a new tab (`rel="noreferrer"`). Alt text: "Homeowner's photo 1", and so on.
Jobs without photos look the same as today.

## Errors

- Upload fails (network, `409`, `413`, `422`): the card shows the API's message, or "We
  couldn't add this photo. You can still book without it." for a network failure. The failed
  thumbnail goes away. The homeowner can try again or continue.
- Remove fails: the photo stays and a toast says it couldn't be removed.
- Photo list fails to load: the card shows no thumbnails and the button still works.
- None of these block Continue.

## Privacy

Photos are only ever served to the homeowner who holds the draft token (while the draft is
open) and to signed-in staff of the same contractor. The browser re-save removes location
data. The server does not re-encode, so a hand-made upload could keep its metadata; it is still
only shown to those two.

## Testing

- API (`vitest`, real Postgres, like `booking-drafts.test.ts`):
  - a JPEG uploads, and the list and image routes return it;
  - a text file gets `422`, a file over 1 MB gets `413`, a 4th photo gets `409`;
  - delete removes it, and deleting twice is fine;
  - an unknown token, another tenant's token and a booked draft all get `404`;
  - adding a photo moves `last_activity_at`;
  - `GET /jobs/:jobId` lists the photos of the booked draft, and the staff image route serves
    them; a photo of another job gets `404`; the route refuses requests without a staff
    session;
  - the cleanup deletes photos of drafts that were never booked and idle for 30 days, and keeps
    newer ones and booked ones.
- Web (`vitest`, no browser): the resize math (4032 × 3024 becomes 1600 × 1200; a photo
  already smaller is not enlarged).
- By hand: screenshots of step 4 with photos at phone, tablet and desktop widths, and of the
  job drawer.

## Order of work

1. API: table and migration, homeowner photo routes, tests.
2. API: photos in the job detail, staff image route, cleanup job, tests.
3. Web: resize helper and test, API hooks, photo card and nudge in step 4.
4. Web: thumbnails in the job drawer. Screenshots.
