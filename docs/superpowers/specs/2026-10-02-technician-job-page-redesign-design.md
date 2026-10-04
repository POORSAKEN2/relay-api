# Technician job page redesign

Date: 2026-10-02. Status: approved design.

A new look and flow for the technician's job page (`/jobs/:jobId`), from the designer's
mockups. Web only: no API change. Real payments (QR code, "All paid", emailed receipt) wait
for module 9; until then the payment screen has stand-ins, listed in `docs/payments-todo.md`.

## Rule

The big bottom button is always the technician's next step. Status shows only as a chip.

| Status | Screen | Bottom button | Small links |
|---|---|---|---|
| `booked` | Job page | **On my way** (minutes sheet, texts the ETA) | I'm already here (start) · Running late · Can't get in |
| `en_route` | On-the-way screen | **I'm at the location** (start) | Open in Maps · Running late · Can't get in · Job details |
| `in_progress`, repairs waiting | Job page | **Review with homeowner · $X** (review sheet) | — |
| `in_progress`, none waiting | Job page | **Job complete** (payment screen) | — |
| `done` | Job page, "Done at 11:42 AM" | — | — |
| `no_access` | Job page, "The office will reschedule this visit." | — | — |

`$X` = approved total + waiting total, the amount the homeowner approves.

## Screens

### Job page

- **Brand band**: `bg-primary`, full width, top ~13rem. Holds a back arrow to `/jobs` (left)
  and the sign-out button (right).
- **Hero card** (white, rounded-3xl, overlaps the band): status chip (+ PRIORITY chip), customer
  name (text-3xl), `Clock` window and `Calendar` date, "Arriving about 9:10 AM" when there is an
  ETA, Call (primary) and Text (outline) when the customer has a phone.
- **Body card** (white, rounded-3xl):
  - Problem box (`bg-muted`): "Problem", the text, system, equipment, vulnerable warning, photos.
  - Address row (`Navigation` icon, card with shadow): street, unit, city, zip; the whole row
    opens Maps. Access notes under it.
  - Notes row (`StickyNote` icon): office notes, or "No notes yet."
  - Charges: `ChargeLines` (unchanged, shared with the office drawer), and **Add repair** while
    in progress.
- **Bottom bar**: fixed to the bottom, the main button (h-14, full width, primary), small links
  above it. Page content gets bottom padding so nothing hides under it.

### On-the-way screen (`en_route`)

Full screen, white: "On the way to" / customer name, a large `Navigation` icon that opens Maps,
the address, access notes, "Arriving about 9:10 AM". At the bottom: status chip, name, window
and date, Call / Text, then the bottom bar. A **Job details** link shows the normal job page
(local state; the bottom bar stays the same), whose hero card then has a **Directions** link
back to this screen.

### Add repair dialog

Price items as rounded rows with a shadow (picked: primary ring), quantity stepper (1–20), one
full-width button **Add repair · $180**. Closes with the dialog's X or the overlay.

### Review sheet (handed to the homeowner)

Full screen: "Your repair estimate", the description, every line, "Total if approved", then
**Approve $X** (primary, h-14), **Decline repairs** (outline), **← Back** (closes, records
nothing).

### Payment screen ("To be paid by homeowner")

Opened by **Job complete**, full screen, handed to the homeowner: the total due in large type,
a dashed QR box ("Card payment by QR is coming soon"), the approved lines and **Total due**,
then **Job done**, a disabled **Email receipt (coming soon)** and **← Back** (closes, records
nothing). A job isn’t done until the homeowner paid: **Job done** stays off until the
techician ticks "Homeowner paid in person (cash or check)". The tick lives only on the screen
(not saved); with nothing due ($0) there is no tick and Job done is on. Only this screen
enforces the rule for now; the API and the office’s Mark done don’t (see
`docs/payments-todo.md`).

### Job done screen

Shown right after **Job done** succeeds: "Job done!", 👏, "Approved total $X", and **Back to
your jobs · 4s**, counting down, then going to `/jobs`. Tapping goes now. Opening a done job
later shows the job page with "Done at …".

## Code

All in `relay-web/src`.

- `routes/job.tsx`: no `PageShell`; renders `JobDetails`.
- `features/technician-jobs/next-step.ts` (+ test): `nextStep(status, waitingCount)` returns
  `'on-my-way' | 'start' | 'review' | 'complete' | null`. The one place that decides the bottom
  button.
- `job-details.tsx`: band, hero card, body card; on-the-way screen when `en_route` and details
  aren't open.
- `on-the-way.tsx`: the en route screen.
- `job-actions.tsx`: the bottom bar and links, the existing sheets (minutes, no access,
  complete), and the review sheet (moved from `job-charges.tsx`, with its own
  `useRepairAction`).
- `job-charges.tsx`: Charges with the Add repair dialog; the review button and sheet leave.
- `job-done.tsx`: the done screen.
- `payment-sheet.tsx`: the payment screen, opened by Job complete from `job-actions.tsx`.

Brand colors only (`bg-primary`, `text-primary-foreground`); status chips keep their fixed
meaning colors. Font stays Geist.

## Errors

Same as today: a toast with the API's message, or "Couldn’t update the job. Check your connection
and try again."; the job reloads. Buttons disable while saving.

## Testing

- Vitest: `nextStep()` for every status, with and without waiting repairs.
- `npm run typecheck`, Biome on touched files, `npm test`.
- In the running app as Sam: booked → On my way → on-the-way screen → I'm at the location →
  add repair → review → approve → Job complete → done screen → back to the list.
