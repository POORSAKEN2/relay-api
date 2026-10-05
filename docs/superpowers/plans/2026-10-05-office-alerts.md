# Office Alerts Implementation Plan

**Goal:** Every booking texts the contractor's owner and office staff who have a phone: a
`priority_alert` at any hour for a priority job, otherwise a `new_booking_alert` that waits
for quiet hours to end. Owner and office users can add their mobile number on the Staff screen.

**Architecture:** `insertBookedJob()` (the one function every booking goes through) calls
`sendOfficeAlert(tenantId, jobId, tx)` in the booking's transaction. A new
`modules/office-alerts` module finds the recipients (active owner/office users with a phone,
minus the booker), builds one body with a pure `officeAlertText()`, and calls `sendText()` per
recipient. Timing comes from `rules.ts` only. No schema change.

**Spec:** `relay-api/docs/superpowers/specs/2026-10-05-office-alerts-design.md`

## Global Constraints

- Start after `feat/homeowner-messages` is merged: it changes `booking.service.ts` too.
- Branch `feat/office-alerts` in `relay-api`, and in `relay-web` for Task 5.
- Lean, plain code a junior developer can debug without AI. Short "why" comments.
- Commit messages lowercase conventional (`feat: …`). No `Co-Authored-By` trailer.
- Biome only on touched files: `npx biome check --write <paths>`.
- Text bodies use plain `'` and `-`, never `’` or `–` (GSM-7 keeps 160 characters per SMS).
- Exact copy: staff phone hint `For booking alerts by text. Leave empty for none.`

## Task 1: rules

- [ ] `src/modules/messaging/rules.ts`: add
      `const STAFF_ROUTINE: TextRule = { consent: 'none', quietHours: true }` with a comment
      ("routine office news: no need to wake anyone"); set `new_booking_alert: STAFF_ROUTINE`.
      `priority_alert` stays `STAFF`.
- [ ] `rules.test.ts`: `new_booking_alert` has `quietHours: true`, `priority_alert` has
      `quietHours: false`, both `consent: 'none'`.
- [ ] `npm test -- rules`; commit `feat: hold routine booking alerts until quiet hours end`.

## Task 2: staff phone (API)

- [ ] `src/lib/fields.ts`: `OptionalPhone`, an empty or blank string becomes `null`, anything
      else goes through `Phone`. `null` (not `undefined`) so an update clears the column.
      ```ts
      // An optional mobile number. Empty means "none", stored as null so an edit can clear it.
      export const OptionalPhone = z.preprocess(
        (value) => (typeof value === 'string' && value.trim() === '' ? null : value),
        Phone.nullable(),
      )
      ```
- [ ] `fields.test.ts`: `''` and `'  '` give `null`; `'0917 123 4567'` gives `'+639171234567'`;
      `'12'` is refused with the phone message.
- [ ] `src/modules/team/staff.schemas.ts`: `phone: OptionalPhone` in `StaffInput`. Update the
      top comment (the phone is for booking alerts).
- [ ] `src/modules/team/staff.queries.ts`: `phone` in `selectStaff` and in `StaffValues`
      (`phone: string | null`).
- [ ] `staff.service.ts`: no change expected; `saveOrExplain()` already maps
      `users_phone_unique` to `409 phone_taken`. Check `invite` passes `input` through whole.
- [ ] `staff.test.ts`: invite with a phone; edit to clear it with `''`; a phone a technician
      already has gives `409 phone_taken`; the list returns `phone`.
- [ ] Commit `feat: owner and office users can save a mobile number`.

## Task 3: office-alerts module

- [ ] `src/modules/office-alerts/office-alerts.queries.ts`
  - `findAlertJob(tenantId, jobId, tx)`: one row joining `jobs`, `tenants`, `services`,
    `properties`. Returns `contractorName`, `tenant: { slug, customDomain,
    customDomainVerifiedAt }` for `tenantUrl()` (as `dispatch.queries.ts → findAssignmentText`
    does), `serviceName`, `city`,
    `date: local(jobs.windowStartsAt, 'YYYY-MM-DD')`, `localStart`, `localEnd`, `source`,
    `priority`, `vulnerableOccupant`, `createdBy`. Copy the shape of
    `homeowner-messages.queries.ts → findVisit`.
  - `listAlertRecipients(tenantId, exceptUserId: string | null, tx)`: `{ id, phone }` where
    tenant matches, role in `('owner', 'office')`, `disabled_at is null`, `phone is not null`,
    and `id <> exceptUserId` when given. Order by name, so tests are stable.
- [ ] `src/modules/office-alerts/wording.ts`
  - `SOURCE_LABELS: Record<JobSource, string>`: `web: 'online'`, `office: 'by the office'`,
    `ai: 'by the AI receptionist'`, `text_back: 'from a text-back'`,
    `recovery_text: 'from a recovery text'`. Add `export type JobSource` in `schema.ts` if it
    isn't there (`(typeof JOB_SOURCES)[number]`).
  - `officeAlertText(job, link): string`: the two bodies from the spec. Reuse `formatDay` and
    `formatWindow` from `src/lib/labels.ts`, with `.replace('–', '-')` as `textTechnician()` in
    `dispatch.service.ts` does.
- [ ] `src/modules/office-alerts/wording.test.ts`: ordinary and priority bodies (both priority
      reasons); every `JOB_SOURCES` entry has a label; no `’` or `–` in any body.
- [ ] `src/modules/office-alerts/office-alerts.service.ts`
      ```ts
      // Texts the contractor's owner and office staff about a new booking, in the booking's
      // transaction. A priority job sends one priority_alert (any hour) instead of the
      // new_booking_alert (held for quiet hours: see rules.ts). The person who booked it is
      // skipped: they know already.
      export async function sendOfficeAlert(tenantId: string, jobId: string, tx: Tx) {
        const job = await queries.findAlertJob(tenantId, jobId, tx)
        const recipients = await queries.listAlertRecipients(tenantId, job.createdBy, tx)
        if (recipients.length === 0) return
        const link = tenantUrl(job.tenant, `/dashboard?date=${job.date}&job=${jobId}`)
        const body = officeAlertText(job, link)
        const kind = job.priority ? 'priority_alert' : 'new_booking_alert'
        for (const person of recipients) {
          await sendText(tenantId, { contact: person.phone, kind, body, toUserId: person.id, jobId }, tx)
        }
      }
      ```
- [ ] Commit `feat: office alert wording and recipients`.

## Task 4: hook into booking

- [ ] `src/modules/booking/booking.service.ts → insertBookedJob()`: after
      `charges.addBookedLines`, `await sendOfficeAlert(tenantId, job.id, tx)`. Update its comment:
      every booking gets its lines and its office alert here.
- [ ] Separate fix, not part of this task: online bookings never emit `booking.priority`. See
      `docs/bug-online-priority-event.md`.
- [ ] `src/modules/office-alerts/office-alerts.test.ts` (database, `test/helpers.ts`). Each
      test reads `messages` rows of kind `new_booking_alert` / `priority_alert`:
  - office user books through `POST` office booking: the owner (with phone) gets one
    `new_booking_alert`, the booking office user gets none.
  - online booking (`bookVisit`): every owner and office user with a phone gets one; `to_user_id`
    and `job_id` set; body has the city and the `/dashboard?date=…&job=…` link.
  - not alerted: disabled user, user without a phone, technician, another contractor's staff.
  - priority online booking (`vulnerableOccupant: true`): one `priority_alert` per recipient,
    no `new_booking_alert`.
  - quiet hours: with the contractor's quiet hours set around `now` (copy the setup in
    `sms.test.ts`), the ordinary alert has `send_after` at the end of quiet hours, the priority
    one is due now.
  - a booking that fails (window full) leaves no alert rows.
- [ ] Run the whole API suite (`npm test`): `booking.test.ts` and `online-booking.test.ts` count
      messages in places and may need the new rows filtered out by kind.
- [ ] Commit `feat: text office staff about every new booking`.

## Task 5: staff phone (web)

- [ ] `relay-web/src/features/team/staff-api.ts`: `phone: string | null` on the staff type;
      `phone: string` on the input.
- [ ] `relay-web/src/features/team/staff-dialog.tsx`: optional "Mobile phone" field, prefilled
      with `formatPhone(editing.phone)`, hint `For booking alerts by text. Leave empty for none.`,
      `409 phone_taken` shown on the field. Copy the field from `technician-dialog.tsx`.
- [ ] `relay-web/src/routes/staff.tsx`: show the formatted phone under the email, or nothing.
- [ ] Test the dialog if a dialog test exists for technicians; typecheck; commit
      `feat: mobile number on the staff dialog`.

## Task 6: check it end to end

- [ ] `SMS_PROVIDER=log`, `npm run dev` in both repos. As the owner, add a phone to
      `office@desert.test` on the Staff screen.
- [ ] Book online as a homeowner: the API log shows `Development only: the text` with the
      office's number and the new-booking body. Book again with the vulnerable-person answer:
      the priority body. Book as the office user: no text to themselves.
- [ ] Open the link from the log: the dashboard opens on that day with the job's drawer.
- [ ] Headless Edge screenshot of the Staff dialog with the phone field.

## Task 7: docs

- [ ] `docs/real-texting-todo.md`: under Done, "Office alerts: `new_booking_alert` and
      `priority_alert` to owner and office users with a phone". Under Should have,
      "Office alerts by email too (module 10)".
- [ ] README demo section: "add a phone to a staff member to get booking alerts". Commit.
