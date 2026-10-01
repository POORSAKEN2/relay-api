# Technician status buttons: on my way, running late, start, no access, complete

Date: 2026-10-02. Status: approved design, waiting for the plan.

Part 2 of MVP module 8 ("Technician job page"). Builds on the technician job list
(`2026-10-01-technician-job-list-design.md`), whose job page is read-only. Now the technician
changes the job from that page. Each change updates the dispatch board live, and the taps a
homeowner is waiting on send them a text.

## Why

Homeowners are promised a 4-hour arrival window. Without these buttons they wait and phone the
office, the office phones the technician, the board is only right if someone updates it by
hand, and a homeowner who wasn't home finds out hours later. "On my way" turns the window
into an arrival time; "Running late" moves it without a phone call; "No access" tells the
office at once and leaves a timestamp; "Job complete" is where invoicing will start
(module 9).

## Out of scope

- Undo. A mistaken "Start job" can't be undone by the technician, and the office's rules don't
  allow In progress → Booked either (only Done or Cancelled). An office-side "back to booked"
  can come later if needed.
- Arrival time worked out from the technician's location.
- Consent and quiet hours for homeowner texts: they belong inside `sendText()` before real
  texting starts (`docs/real-texting-todo.md`). This change only calls `sendText()`.
- Invoice and review texts (module 9, Payments), texted job links (part 3), technician photos
  and notes (part 4) apart from the optional No access note.

## What the technician sees

### Buttons on the job page, by status

| Status | Shown |
|---|---|
| Booked | "Arriving about 11:15 AM" when Running late set a time, then **On my way** (main), Running late, Start job, No access |
| En route | "Arriving about 9:10 AM", then **Start job** (main), Running late, No access |
| In progress | **Job complete** (main) |
| No access | "The office will reschedule this visit." No buttons. |
| Done | "Done at 11:42 AM." No buttons. |

These follow the office's status rules: booked → en route, in progress or no access; en route
→ in progress or no access; in progress → done. Running late is not a status change.

### Each tap

- **On my way**: a sheet with 15, 30, 45 and 60 minutes, each showing the time it means
  ("15 min · 9:10 AM"). One tap saves the arrival time, marks the job En route and texts the
  homeowner.
- **Running late**: the same sheet with 90 minutes too, counted from now. Allowed on Booked
  and En route jobs. Saves the new arrival time and texts the homeowner; the status stays.
- **Start job**: one tap. Marks the job In progress. No text.
- **No access**: a sheet: "Couldn't get in? We'll text the homeowner and the office will
  reschedule." with an optional note ("Gate locked, knocked and called at 1:30"). Confirming
  marks the job No access, saves the note as a job note under the technician's name, and
  texts the homeowner.
- **Job complete**: a confirm, "Mark this visit done? This can't be undone." Marks the job
  Done. No text: the invoice text comes with Payments.

While a tap is saving, every button is disabled and the tapped one shows a spinner.

### Texts to the homeowner

The technician's first name, times in the contractor's time zone:

- On my way: `Desert Breeze Air: Sam is on the way and should arrive about 9:10 AM.`
- Running late: `Desert Breeze Air: Sam is running late and should now arrive about 11:15 AM. Sorry for the wait.`
- No access: `Desert Breeze Air: Sam came by at 1:30 PM but couldn't reach you. We'll call you to set a new time.`

A customer without a phone number gets no text; the change still happens.

### The list

A new **Earlier** section at the top: jobs from before today that are still Booked, En route
or In progress, oldest first, so a technician can finish yesterday's visit. No access jobs are
left out; rescheduling them is the office's job. Cards of en-route jobs show "Arriving about
9:10 AM".

### The office

Board cards and the job drawer show "Arriving about 9:10 AM" for jobs with an arrival time
that are Booked or En route, updated live. The office keeps changing statuses by hand as
before; office changes send no texts.

## API

### One shared status change (`modules/dispatch`)

The core of today's `setStatus()` moves into an exported `changeStatus()` in
`dispatch.service.ts`, used by the office route and the technician routes:

- Locks the job, checks the transition with today's rules and messages (`422
  invalid_transition`, `422 technician_required`), and returns early without changes when the
  job already has that status (a double tap).
- Saves the status, `completed_at` when done, clears job links when done or cancelled, and
  saves `eta_at` when given.
- Optional `technicianId`: the job must be assigned to that technician, otherwise `404
  not_found` "This job isn’t assigned to you anymore." (the technician job page's message).
- Optional `then(job, tx)`: runs in the same transaction after the update, for the homeowner
  text and the No access note. Only runs when the status changed.
- Writes the `job.status_changed` audit event with the acting user, and emits
  `job.status_changed` after the transaction.

The office's `setStatus()` becomes a thin call to it; office behaviour does not change.

### Technician routes (`modules/technician-jobs`)

All `requireRole('technician')`. Each answers with the refreshed job page (`getMyJob()`).

| Route | Body | Does |
|---|---|---|
| `POST /api/my-jobs/:jobId/on-my-way` | `{ minutes: 15 \| 30 \| 45 \| 60 }` | → en route, `eta_at` = now + minutes, `on_my_way` text |
| `POST /api/my-jobs/:jobId/running-late` | `{ minutes: 15 \| 30 \| 45 \| 60 \| 90 }` | Booked or En route only: `eta_at` = now + minutes, `running_late` text; status unchanged |
| `POST /api/my-jobs/:jobId/start` | — | → in progress |
| `POST /api/my-jobs/:jobId/no-access` | `{ note?: string }`, trimmed, at most 1000 characters | → no access; a non-empty note becomes a job note by the technician; `no_access` text |
| `POST /api/my-jobs/:jobId/complete` | — | → done |

- Running late is not a status change, so it doesn't use `changeStatus()`. It locks the job,
  checks it is this technician's (404) and Booked or En route (`422 invalid_transition` "This
  job is In progress, so it can’t be running late."), saves `eta_at`, writes a
  `job.eta_changed` audit event (`{ etaAt, minutes }`), saves the text, and emits
  `job.status_changed` so the board and the technician's pages reload.
- Texts go through `sendText()` in the same transaction as the change, so both are saved or
  neither is. `sendText()` gains optional `jobId` and `customerId`, saved on the `messages`
  row.
- Times in texts and labels are formatted in the contractor's time zone (`tenants.timezone`).

### What the screens get

- Technician job page (`GET /api/my-jobs/:jobId`): adds `etaLabel` (`'9:10 AM'` or null),
  `completedLabel` (`'11:42 AM'` or null) and `timezone` (the contractor's, e.g.
  `'America/Phoenix'`).
- Technician list (`GET /api/my-jobs`): adds `earlier: [card]` (same card shape as `days`),
  and every card gets `etaLabel`.
- Board (`GET /api/dispatch/board`) job cards and the office drawer (`GET /api/jobs/:jobId`)
  get `etaLabel` too: the arrival time while the job is Booked or En route, otherwise null.

No migration: `jobs.eta_at` already exists.

## Web

- `features/technician-jobs/`: hooks for the five actions (each puts the returned job page in
  the cache), the button area, the minutes sheet, the No access sheet and the Job complete
  confirm, using the existing `Dialog` and `Button`.
- `arrivalPreview(now, minutes, timezone)` builds "15 min · 9:10 AM" for the sheet, in the
  contractor's time zone (the job page's `timezone`), so it always matches the homeowner's text.
  (First written as "the phone's local time"; changed after the live check showed a phone in
  another zone would preview times that disagree with the text.)
- The list shows the Earlier section and `etaLabel`; the board card and the job drawer show
  `etaLabel`.

## Errors

- Network failure on a tap: "Couldn't update the job. Check your connection and try again."
  Nothing is saved; the buttons come back.
- 422 (the office changed the job meanwhile): the API's message in a toast, and the job page
  reloads to the real status.
- 404 (reassigned or cancelled): the job page shows "This job isn’t assigned to you anymore."
  with Back to your jobs, as in part 1.

## Testing

- API:
  - the dispatch tests still pass unchanged (office behaviour kept);
  - each of the five actions: status, `eta_at`, audit actor, text kind and body with the time
    in the contractor's time zone, `job_id` and `customer_id` on the message;
  - a second tap of the same action sends no second text;
  - running late on a Booked job keeps it Booked; on an In progress job it's refused;
  - no access saves a trimmed, non-empty note as a job note by the technician;
  - complete stamps `completed_at`;
  - a customer without a phone gets no text and the change still happens;
  - another technician's job gets 404; a forbidden transition 422; office users 403;
  - the list's `earlier` holds only Booked, En route and In progress jobs from before today;
  - board, drawer, technician list and job page carry `etaLabel`.
- Web: `arrivalPreview()`.
- In the running app at phone width as Sam Patel: On my way, Running late, Start job and Job
  complete on one job and No access on another, with the board open in an office window
  showing each change and the arrival time live, and the saved texts checked in `messages`.
