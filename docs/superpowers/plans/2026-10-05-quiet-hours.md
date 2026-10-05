# Quiet Hours Enforced Implementation Plan

**Goal:** No text whose rule has `quietHours: true` reaches httpSMS during the contractor's quiet
hours, even when it was saved earlier and sent late (downtime, retries). A held text keeps its
tries. Staff texts, replies, visit texts and emails are never held.

**Architecture:** `sendText()` already holds texts with `send_after` when they are saved. This
adds the same check in the sender loop, right before a claimed text goes to httpSMS. If it is
quiet hours, the row goes back to waiting until `quiet_hours_end` and the try is given back.
The rule still comes only from `TEXT_RULES` and the time only from `quietUntil`. No pg-boss job,
no schema change.

**Spec:** `relay-api/docs/superpowers/specs/2026-10-05-quiet-hours-design.md`

## Global Constraints

- Branch `feat/quiet-hours-at-send` in `relay-api`. API only; no `relay-web` change.
- Lean, plain code a junior developer can debug without AI. Short "why" comments.
- Commit messages lowercase conventional (`feat: …`, `test: …`). No `Co-Authored-By` trailer.
- Biome only on touched files: `npx biome check --write <paths>`.
- Tests need the local test database (`npm test` uses `test/global-setup.ts`).

## Task 1: move `endOfQuietHours` to its own file

- [x] New `src/modules/messaging/quiet-hours.ts`:
      ```ts
      import { type Db, db } from '../../db/client.ts'
      import * as queries from './messaging.queries.ts'
      import { quietUntil } from './rules.ts'

      // When quiet hours end for this contractor, if it is quiet hours now; else null.
      // sendText() asks when it saves a text, and the sender asks again just before sending
      // one, so a text sent late (downtime, a retry) still never goes out at night.
      export async function endOfQuietHours(tenantId: string, tx: Db = db) {
        const quiet = await queries.findQuietHours(tenantId, tx)
        return quietUntil(new Date(), quiet.timezone, quiet.start, quiet.end)
      }
      ```
- [x] `src/modules/messaging/sms.ts`: delete the local `endOfQuietHours`, import it from
      `./quiet-hours.ts`, and drop `quietUntil` from the `./rules.ts` import.
- [x] `npm test -- sms rules` passes unchanged.
- [x] Commit `refactor: quiet hours check in its own file for the sender to share`.

## Task 2: the sender checks quiet hours before sending

- [x] `src/modules/messaging/messaging.queries.ts`:
  - `claimDueMessages()`: add `kind: messages.kind` to `.returning({...})`.
  - After `claimDueMessages`, add:
    ```ts
    // A claimed text that must wait for quiet hours: back to waiting until they end, and the
    // try claimDueMessages counted is given back. Status is left alone, so a STOP that blocked
    // it meanwhile still stands.
    export async function holdUntil(messageId: string, sendAfter: Date) {
      await db
        .update(messages)
        .set({ sendAfter, attempts: sql`${messages.attempts} - 1` })
        .where(eq(messages.id, messageId))
    }
    ```
- [x] `src/modules/messaging/sender.ts → sendDueMessages()`, at the top of the loop:
      ```ts
      for (const message of due) {
        // Checked again here, not only when the text was saved: one saved at 20:45 must not go
        // out at 23:00 because the server or the phone was down, or a retry crossed 21:00.
        if (message.channel === 'sms' && TEXT_RULES[message.kind].quietHours) {
          const until = await endOfQuietHours(message.tenantId)
          if (until) {
            await queries.holdUntil(message.id, until)
            continue
          }
        }
        const lastTry = message.attempts >= MESSAGE_MAX_ATTEMPTS
        ...
      }
      ```
      Imports: `TEXT_RULES` from `./rules.ts`, `endOfQuietHours` from `./quiet-hours.ts`.
      Add one line to the comment at the top of the file: texts whose rule waits for quiet
      hours are checked again just before sending.
- [x] `src/modules/messaging/sender.test.ts`, new `describe('quiet hours', ...)`:
  - `beforeEach`: `vi.useFakeTimers({ toFake: ['Date'] })`; `afterEach`: `vi.useRealTimers()`.
    Only JavaScript's Date is faked: the database's `now()` stays real, so rows saved with the
    default `send_after` are still due.
  - Helper `at(time)` → `vi.setSystemTime(new Date(\`2030-01-08T${time}-07:00\`))` (Phoenix,
    quiet 21:00 to 08:00, set by `createTenant`).
  - At `23:00:00`, `queueText(tenant.id, { kind: 'reminder' })`: `sendSms` not called;
    `reload()` gives `status: 'queued'`, `attempts: 0`,
    `sendAfter = new Date('2030-01-09T08:00:00-07:00')`.
  - At `23:00:00`, `kind: 'reminder', attempts: 2`: held with `attempts: 2`,
    `status: 'queued'` (not `failed`).
  - At `23:00:00`, `on_my_way` and `job_assigned`: both handed to `sendSms`
    (`toHaveBeenCalledTimes(2)`).
  - At `23:00:00`, `new_booking_alert`: not sent, held until 08:00.
  - At `23:00:00`, an email with `kind: 'reminder'` (reuse the `queueEmail` shape): `sendEmail`
    called, `status: 'sent'`.
  - At `14:00:00`, `reminder`: handed to `sendSms`.
- [x] `src/modules/messaging/sms.test.ts`, one new test next to the quiet-hours one: at
      `2030-01-08T23:00:00-07:00`, `sendText` for `job_assigned` and then (after
      `db.delete(messages)` and a consent row) `text_back`: each `sendAfter` is before
      `2030-01-09`, i.e. not held. Covers the task's "staff texts are exempt" directly.
- [x] `npm test -- sender sms rules`; then full `npm test`; `npm run typecheck`.
- [x] Commit `feat: hold texts at send time when quiet hours have started`.

## Task 3: docs

- [x] `docs/real-texting-todo.md`, under `[x] Quiet hours: unprompted texts wait until
      quiet_hours_end (send_after).` add:
      `  - [x] Checked again just before sending, so downtime or a retry never sends one at night.`
- [x] `docs/httpsms-setup.md`, the quiet-hours bullet (around line 133): add that a text
      already waiting is checked again when it is due, and that replies, visit texts, staff
      texts and emails are never held.
- [x] `npx biome check --write` on the touched files.
- [x] Commit `docs: quiet hours checked at send time`.

## Manual check (optional, `SMS_PROVIDER=log`)

1. In psql, put the demo contractor in quiet hours now:
   `update tenants set quiet_hours_start = '00:00', quiet_hours_end = '23:59' where slug = 'desert';`
2. Insert a due `reminder` row in `messages` for `desert` (outbound, `queued`, `send_after`
   now) and start `npm run dev`.
3. Within 5 seconds: no "Text logged" line for it, and
   `select send_after, attempts from messages where kind = 'reminder'` shows 23:59 local and
   `attempts = 0`.
4. Put the defaults back:
   `update tenants set quiet_hours_start = '21:00', quiet_hours_end = '08:00' where slug = 'desert';`
