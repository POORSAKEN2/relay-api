# Schedule settings and priority jobs pinned on the board

Date: 2026-10-08. Status: draft, waiting for review.
Builds on: `2026-10-04-waitlist-offer-design.md` (offers hold a window by `offer_window_id`, with
no foreign key) and the dispatch board (`src/modules/dispatch/`, relay-web `features/dispatch/`).

## Problem

1. A contractor's business hours, arrival windows and jobs-per-window cap live in
   `business_hours` and `arrival_windows`, but only `seed-dispatch.ts` writes them. There is no
   API and no screen, so a contractor can't change when customers can book or how many jobs a
   window takes.
2. The board API sorts PRIORITY jobs first, but only inside each window × technician cell. A
   priority job in the 2–4 PM row sits below the fold, under the morning's routine jobs.

The third task in this area, the office text alert for priority jobs, is already built
(`src/modules/office-alerts/`, 2026-10-05): every new booking texts owner and office users who
have a phone, and a priority job sends a `priority_alert` at any hour. It is out of scope here.

## Goal

1. A new **Schedule** page in the staff sidebar, right after Dispatch, where owner and office
   edit:
   - **Business hours:** one open and close time, plus the days they apply to.
   - **Arrival windows:** one shared list of windows (start, end, cap), plus the days they apply
     to.
2. Saving a change that touches upcoming jobs **warns first** ("3 upcoming jobs are booked in
   windows you're changing. They'll keep their times."), then saves. Booked jobs never move.
3. On the dispatch board, the day's **priority jobs show in a Priority section at the top**,
   above the grid (desktop) or the window list (phone).

Done means: an office user changes the windows from 8–12 / 12–4 to 8–11 / 11–2 / 2–5, sees the
warning, saves. The board and the booking page show the new windows on every ticked day, and the
already-booked jobs still show under "Other times". A priority job booked for 4 PM sits at the
top of the board.

## Out of scope

- Different hours or windows per weekday (for example, a short Saturday). The screen edits one
  shared set. Days whose saved rows differ (only possible from old data) are made equal on save.
- Holidays, one-off closed dates or date-specific windows.
- Anything that *uses* business hours. Today nothing reads them (the schema says the AI answers
  outside them; that isn't built). The screen only saves them.
- Caps per technician, or per service.
- Moving or cancelling jobs from the Schedule page. The board does that.
- Changing the office text alert.

## Decisions

| Question | Choice |
|---|---|
| Windows layout | One shared set of windows + day checkboxes |
| Hours layout | One open/close time + day checkboxes |
| Booked jobs a change touches | Warn, then save. Jobs keep their times |
| Where | New "Schedule" page in the sidebar, after Dispatch |
| Who can edit | Owner and office (same as Booking settings) |
| Saving | The whole schedule in one request, one transaction |
| Priority on the board | A Priority section above the board, jobs also stay in their cells |

## API (relay-api)

New module `src/modules/schedule/` (`schedule.routes.ts`, `schedule.schemas.ts`,
`schedule.service.ts`, `schedule.queries.ts`, `schedule.test.ts`), mounted with the other staff
routes in `app.ts`. All three routes use `requireRole('owner', 'office')`.

### Shape

```ts
type Schedule = {
  hours: { days: number[]; opensAt: string; closesAt: string } | null // null: closed every day
  windows: { startsAt: string; endsAt: string; jobCap: number }[]       // sorted by startsAt
  windowDays: number[]                                                   // 0 = Sunday … 6 = Saturday
}
```

Times are `'HH:MM'` in the contractor's local time.

### `GET /api/schedule`

Reads `business_hours` and `arrival_windows` for the tenant.

- `hours`: `null` when there are no rows. Otherwise `days` is every weekday with a row, and the
  times are those of the lowest weekday with a row.
- `windowDays`: every weekday with at least one window.
- `windows`: the windows of the lowest weekday in `windowDays`. Empty if none.

When saved days differ (old data), the page shows the first day's values, and saving makes every
ticked day equal to them.

### Validation (`ScheduleInput`, zod)

- Times match `HH:MM`, minutes `00` or `30`, from `00:00` to `23:30`. `closesAt > opensAt`,
  `endsAt > startsAt`. A window or hours can't run past midnight (the schema checks the same).
- `hours`: `null`, or `days` with 1–7 distinct values in 0–6.
- `windows`: 1–8 items. `jobCap` an integer 1–20. No two windows overlap (touching is fine:
  8–12 and 12–4). Start times are unique.
- `windowDays`: 1–7 distinct values in 0–6.
- Windows outside business hours are allowed.

Messages follow the existing style, for example "Windows can't overlap: 8:00 AM – 12:00 PM and
11:00 AM – 2:00 PM" and "Enter a cap from 1 to 20 jobs".

### `POST /api/schedule/check`

Body: `ScheduleInput`. Saves nothing. Returns `{ affectedJobs: number }`: upcoming jobs that would
no longer match a window with the same start and end.

A job counts when:
- its status isn't inactive (`cancelled`, `expired`) or `done`,
- `window_starts_at >= now()`, and
- in the new schedule, its local weekday isn't in `windowDays`, or no window has the job's local
  start **and** end time.

Jobs on unchanged windows don't count, so saving an unchanged schedule returns 0. A cap lowered
below what's booked doesn't count either: the window just shows as full, as it does today.

### `PUT /api/schedule`

Body: `ScheduleInput`. In one transaction:

1. **Hours:** delete the tenant's `business_hours`, insert one row per day in `hours.days`
   (none when `hours` is `null`).
2. **Windows,** for each weekday 0–6:
   - not in `windowDays`: delete its windows.
   - in `windowDays`: a saved window whose `starts_at` matches a new window is **updated in
     place** (`ends_at`, `job_cap`), keeping its `id`. Saved windows with no match are deleted.
     New windows with no match are inserted.

   Keeping the `id` keeps an open waitlist offer on that window working. An offer on a deleted
   window already stops working without errors (see the waitlist-offer design); its homeowner
   stays on the waitlist and gets the next opening.
3. Audit: `settings.schedule_updated`, entity `tenant`, data
   `{ hoursDays, windowDays, windows: <count> }`, like `settings.service_area_updated`.

After the commit, emit `schedule.updated` to the tenant (`emitToTenant`), and return the new
`Schedule`.

Updates in place must avoid the `(tenant_id, weekday, starts_at)` unique key clashing mid-save:
deletes run before inserts, and in-place updates never change `starts_at`.

### Errors

- Invalid body: the usual 400 with zod messages (`validation_failed`).
- Not owner/office: 403, as other staff routes.

## Web (relay-web)

### Schedule page

- Route `/schedule` (staff layout), `src/routes/schedule.tsx`. Sidebar link "Schedule" with the
  `Clock` icon, after Dispatch in `sidebar-links.ts`. Owner and office see it, like the rest of
  the staff sidebar.
- API hooks in `src/features/schedule/api.ts`: `useSchedule`, `useCheckSchedule`,
  `useSaveSchedule`, and `useScheduleLiveUpdates` (refetch on `schedule.updated`).
- One form, one **Save** button, two cards:
  - **Business hours:** an "Open" and "Close" time select (half-hour steps, 12-hour labels), and
    seven day checkboxes (Sun–Sat). No days ticked shows "Closed every day".
  - **Arrival windows:** a row per window with Start, End, Cap and a remove button.
    "Add window" adds a row starting where the last one ends (if it fits before midnight). Seven
    day checkboxes below. A help line: "Customers book a window, not an exact time. The cap is
    how many jobs a window takes, for the whole team."
- Validation runs in the browser with the same rules (shared helpers in
  `src/features/schedule/rules.ts`), showing errors next to the field. The API's errors show the
  same way if they get through.
- **Save** first calls `check`. If `affectedJobs > 0`, a `ConfirmDialog`: title "Upcoming jobs
  booked", message "N upcoming jobs are booked in windows you're changing. They'll keep their
  times and show under Other times on the board.", confirm "Save anyway". Otherwise it saves
  straight away. A toast "Schedule saved" on success.
- Leaving the page with unsaved changes isn't blocked (no other settings page blocks it).

### Live updates

On `schedule.updated`, invalidate the schedule query and the board queries (the dashboard adds
`useScheduleLiveUpdates`), so an open board shows the new windows.

## Priority jobs pinned on the board

The board API is unchanged: `GET /api/dispatch/board` already returns jobs PRIORITY first, with
`priority` on each job.

Web, `src/routes/dashboard.tsx` and a new `src/features/dispatch/priority-strip.tsx`:

- Between the day summary and the board, a **Priority** section lists the day's priority jobs
  that aren't `done`, in board order (window start, then booked time). Hidden when there are
  none.
- Each is a `JobCard` with the technician's name (or "Unassigned") and its window label
  (`9:00 AM – 12:00 PM`, or the job's own times under "Other times"). Clicking opens the job
  drawer, like any card.
- Desktop: the cards sit in a wrapping row with a red-tinted header, "Priority · 2 jobs". Phone:
  the same section above the window list.
- The jobs **also stay in their window × technician cell**, so drag-and-drop and capacity counts
  don't change. The strip's cards aren't draggable.
- A pure helper `priorityJobs(board)` in `place-jobs.ts` picks and orders them, plus a
  `windowLabel(board, job)` helper.

## Testing

API (`schedule.test.ts`, supertest against the test database, like `settings.test.ts`):
- GET returns the seeded schedule; `hours: null` with no rows; first day's values when days
  differ.
- PUT saves hours and windows on ticked days only, removes the rest, keeps `id` for windows whose
  start is unchanged, writes the audit row, emits `schedule.updated`.
- PUT with an unchanged schedule changes nothing (same ids).
- Validation: overlap, end before start, cap 0 and 21, bad minutes, no window days, 9 windows.
- check: 0 for unchanged; counts a job in a removed window, in a window whose end changed, and on
  an unticked day; ignores past, cancelled and done jobs, and a lowered cap.
- 403 for a technician.
- The booking page's availability uses the new windows after a save (one test through the
  existing availability route).

Web (vitest):
- `rules.ts`: overlap, ordering, cap range, "add window" start time.
- `priorityJobs` and `windowLabel`: order, `done` excluded, other-times label.

Manual: change windows on the Schedule page with a booked job in a changed window, see the
warning, save, and check the board and the booking page.
