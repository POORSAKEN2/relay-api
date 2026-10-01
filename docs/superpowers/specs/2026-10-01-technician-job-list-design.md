# Technician job list: see the jobs the office assigned

Date: 2026-10-01. Status: approved design, waiting for the plan.

First part of MVP module 8 ("Technician job page"). A signed-in technician sees the jobs the
office assigned to them, today and the next 6 days, and opens one to see everything for the
visit. Read-only: nothing a technician does here changes a job yet.

Builds on technician sign-in (`2026-10-01-technician-sign-in-design.md`) and booking photos
(`2026-10-01-booking-photos-design.md`). Both are merged to `main` before this work starts.

## Module 8, split up

Each part gets its own spec and plan.

1. **See assigned jobs** (this spec).
2. Status buttons: "On my way", "Running late", "Start job", "No access", "Job complete". Each
   updates the board and texts the homeowner. Overdue jobs from earlier days come with it.
3. A text with a job link when a job is assigned or moved; links that expire when the job
   closes (`jobs.tech_link_hash`).
4. Technician photos and notes.
5. Adding the repair from the price list and taking payment (needs module 9, Payments).

## Out of scope

Everything in parts 2 to 5, customer history, and jobs from before today. A visit from
yesterday that is still open does not show; part 2 deals with overdue jobs.

## What the technician sees

### `/jobs` — "Your jobs"

Replaces the placeholder from technician sign-in. Phone-first.

- **Today** first, then the next 6 days, one heading per day ("Tue, Oct 7"). Days without
  jobs are left out.
- One card per job: arrival window ("8 AM–12 PM"), homeowner name, street and city, service,
  and a status chip (Booked, En route, In progress, No access, Done). A red PRIORITY chip when
  the job is priority.
- Within a day: earliest window first, then priority first, then oldest booking first.
- Done jobs stay, greyed, at the bottom of their day. Cancelled, held and expired jobs never
  show.
- No jobs at all: "No jobs assigned to you for the next 7 days."
- A card opens `/jobs/:jobId`. The sign-out button stays in the header.

### `/jobs/:jobId` — the job page

Read-only. Replaces the `/jobs/:token` placeholder: texted job links (part 3) get their own
short path later.

- Header: homeowner name, service, day and window, status chip, PRIORITY chip.
- Contact: big **Call** (`tel:`) and **Text** (`sms:`) buttons for the homeowner's phone.
- Address with an **Open in Maps** link, plus the property's access notes ("Gate code 4321").
- Problem: the homeowner's words, the system type, the red "Someone vulnerable is home without
  heat or cooling." line when set, and equipment brand and age when known.
- The homeowner's booking photos as thumbnails; each opens full size in a new tab.
- The office's notes, read-only, oldest first, with author and time.
- **Back to your jobs** at the top.

### Live updates

When the office assigns, moves, reassigns, books with a technician, changes a status or
deactivates a technician, the list and an open job page reload within a second. A job page
whose job is no longer this technician's shows "This job isn't assigned to you anymore." with
**Back to your jobs**.

## API: `modules/technician-jobs`

Every route is `requireRole('technician')`. The contractor and the technician come from the
session, never from the request.

| Route | Answer |
|---|---|
| `GET /api/my-jobs` | `{ days: [{ date, label, jobs: [{ id, status, priority, windowLabel, customerName, street, city, serviceName }] }] }` |
| `GET /api/my-jobs/:jobId` | `{ job, notes, photos }` |
| `GET /api/my-jobs/:jobId/photos/:photoId` | The photo's bytes, sent with `sendPhoto()` |

### The list

- Jobs where `technician_id` is the signed-in technician and the window starts on or after the
  start of today and before the start of the 7th day ahead, both in the contractor's time zone
  (`tenants.timezone`), like the dispatch board.
- Statuses `booked`, `en_route`, `in_progress`, `no_access` and `done`. Never `held`, `expired`
  or `cancelled`.
- Grouped by local day, labels from `formatDay()` and `formatWindow()` like the board. Sorted
  by window start, then priority first, then `created_at`, with done jobs last within a day.
- This is the only new query.

### The job page

- Reuses the dispatch module's queries: `findJobDetail`, `listNotes` and `listJobPhotos`. No
  second copy of that SQL.
- The service checks that the job's technician is the signed-in user and its status is one of
  the five above, then returns only what a technician needs:
  - `job`: `id`, `status`, `priority`, `problem`, `systemType`, `vulnerableOccupant`,
    `dateLabel`, `windowLabel`, `service: { name }`, `customer: { name, phone }`,
    `property: { street, unit, city, state, zip, notes, equipmentBrand, equipmentYear }`.
    Not `technician`, `windowId`, `allowedStatuses`, the customer's email or the source.
  - `notes`: as the board gets them (`body`, `authorName`, `createdAt`).
  - `photos`: `{ id, url }`, `url` = `/my-jobs/<jobId>/photos/<photoId>`, a path under the API.
- Not this technician's, unassigned, another contractor's, or held, expired or cancelled: all
  `404 not_found` "This job isn't assigned to you anymore." The page can't tell "not yours"
  from "doesn't exist".
- `jobId` and `photoId` that aren't UUIDs: `400`, like the board's routes.

### The photo route

Serves a booking photo only when its job passes the same check as the job page. Same headers
as every other photo (`sendPhoto()`).

### Access

Owner and office users get `403` on these routes; signed-out visitors `401`. Technicians still
can't open the office routes (`/api/jobs/...`, `/api/dispatch/board`). Office routes don't
change.

### Live updates

Nothing new on the server. Technicians already join their contractor's live room. The
technician pages listen for the existing `job.assigned`, `job.status_changed` and
`booking.created` events, whose payloads hold only a job id and dates, and reload the list and
the open job page on any of them. Deactivating a technician already sends `job.assigned` for
the jobs it moves.

## Web: `features/technician-jobs`

- `api.ts`: Zod schemas and hooks for the three routes, plus the live-update hook. Photo URLs
  get the API's address in front, like technician and booking photos.
- `maps.ts`: builds the Maps link from the address
  (`https://www.google.com/maps/search/?api=1&query=<address>`), which opens the Maps app on
  phones.
- The list and the job page, using the existing `PageShell`, `Card` and `Badge` and the board's
  status labels and colours (`features/dispatch/labels.ts`).
- `routes/technician-home.tsx` shows the list; `routes/job.tsx` becomes `/jobs/:jobId`.

## Errors

- The list can't load: "We couldn't load your jobs." with **Try again**. Offline shows the
  usual network message (`errorMessage()`).
- The job page gets 404: "This job isn't assigned to you anymore." with **Back to your jobs**.
- The live connection drops: TanStack Query reloads when the tab comes back into focus, and
  Socket.IO reconnects by itself.
- A photo doesn't load: its alt text shows; nothing else breaks.

## Testing

- API (`technician-jobs.test.ts`, real Postgres, like `dispatch.test.ts`):
  - the list holds only this technician's jobs, from today to 6 days ahead in the contractor's
    time zone, grouped by day and sorted as above, without held, expired or cancelled jobs and
    with done ones last;
  - the job page returns the fields above and none of the office-only ones;
  - another technician's job, an unassigned job, another contractor's job and a cancelled job
    all get 404 with the same message;
  - the photo route serves photos of this technician's jobs only;
  - office users get 403, signed-out visitors 401.
- Web (`vitest`): the Maps link builder.
- In the running app at phone width: sign in as Sam Patel, have the office assign him a job on
  the board, see it appear without a refresh, open it, check Call, Text, Maps and the photos,
  then reassign it and see it leave.
