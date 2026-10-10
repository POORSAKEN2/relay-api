# Lead Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send the abandoned-booking text and a new missed-caller reminder the next morning with three open arrival windows, and never text a draft that reached the gas / carbon monoxide safety stop.

**Architecture:** A pure `lastMorning()` next to `quietUntil()` defines "the morning" (when a contractor's quiet hours end). A small `online-booking/recovery.ts` lists the contractors whose morning has begun, with the time range of leads due today, and reads their next open windows. The existing `booking-recovery` job (every 5 minutes) runs the reworked `sendRecoveryTexts()` and the new `sendMissedCallerReminders()`. The safety stop is a new draft column set by a new public route that the web safety screen calls.

**Tech Stack:** Node 22 + TypeScript (run directly, `.ts` imports), Express 5, Drizzle ORM + drizzle-kit on Postgres, Vitest + supertest against a test database, Biome. Web: React + TanStack Query, Vite.

**Spec:** `docs/superpowers/specs/2026-10-10-lead-recovery-design.md`

## Global Constraints

- Branch `feat/lead-recovery` in `relay-api` (already created, spec committed) and in `relay-web`.
- Commit messages: conventional prefix (`feat:`, `docs:`), lower case, **no `Co-Authored-By` line or any other trailer**.
- Texts are plain ASCII: no en dash, no curly quotes, so they stay in the cheaper SMS encoding.
- `missed_caller_reminder` stays `UNPROMPTED` in `messaging/rules.ts` (consent required). Do not change any text rule.
- Constants: 60-minute quiet gap (`WAIT_MINUTES`), 3 open times (`OPEN_TIMES`), 14 days ahead (`DAYS_AHEAD`), 7-day reminder gap (`REMINDER_GAP_DAYS`).
- Comments in the codebase's voice: plain sentences saying why, no JSDoc.
- Commands run from the repo root: `npm test`, `npm run typecheck`, `npm run lint`. One file: `npx vitest run <path>`.
- Tests need `TEST_DATABASE_URL` in `relay-api/.env` (already set up; global setup migrates the test database).

## Review Focus

Each line has a test in the named task.

1. A contractor in another time zone: the morning is local to it. Task 1 tests Manila and Phoenix.
2. A homeowner who comes back to the draft after the morning: not texted today. Task 4, "active after the morning".
3. The job runs while the contractor is in quiet hours: nothing is written, not even for due leads. Task 4 and Task 5, "quiet hours".
4. The job was down a whole day: a lead from before the previous morning is never texted late. Task 4, "older than the previous morning".
5. A missed caller who texted STOP after once agreeing: no reminder. Task 5, "opted out".

---

### Task 1: `lastMorning()`

**Files:**
- Modify: `src/modules/messaging/rules.ts` (add after `quietUntil`, before `secondsOfDay`)
- Test: `src/modules/messaging/rules.test.ts`

**Interfaces:**
- Produces: `lastMorning(now: Date, timezone: string, end: string): Date`. `end` is a wall-clock time like `'08:00:00'`. Returns the latest moment at or before `now` when local time was `end`.

- [ ] **Step 1: Write the failing test**

Change the import line of `src/modules/messaging/rules.test.ts` to:

```ts
import { HOMEOWNER_KINDS, lastMorning, quietUntil, TEXT_RULES } from './rules.ts'
```

Add after the test `'handles a window that doesn’t cross midnight'`:

```ts
it('finds the morning: the last time quiet hours ended', () => {
  const morning = (time: string) => lastMorning(manila(time), 'Asia/Manila', '08:00:00')
  expect(morning('10:30:00')).toEqual(manila('08:00:00'))
  expect(morning('08:00:00')).toEqual(manila('08:00:00'))
  expect(morning('23:59:00')).toEqual(manila('08:00:00'))
  // Before 8 AM the last morning was yesterday's.
  expect(morning('07:00:00')).toEqual(new Date('2030-01-07T08:00:00+08:00'))
})

it('finds the morning in a time zone behind UTC, and at another hour', () => {
  // Phoenix is UTC-7 with no daylight saving: 09:15 local is 16:15 UTC.
  const now = new Date('2030-01-08T16:15:00Z')
  expect(lastMorning(now, 'America/Phoenix', '07:30:00')).toEqual(
    new Date('2030-01-08T07:30:00-07:00'),
  )
  expect(lastMorning(now, 'America/Phoenix', '10:00:00')).toEqual(
    new Date('2030-01-07T10:00:00-07:00'),
  )
})
```

- [ ] **Step 2: Run the test to see it fail**

Run: `npx vitest run src/modules/messaging/rules.test.ts`
Expected: FAIL, `lastMorning` is not exported (`TypeError: lastMorning is not a function` or a TS import error).

- [ ] **Step 3: Implement**

In `src/modules/messaging/rules.ts`, after the `quietUntil` function:

```ts
// The last moment quiet hours ended, at or before `now`: the contractor's morning. The
// lead-recovery texts go out once it has begun. Off by up to an hour on daylight-saving days,
// like quietUntil.
export function lastMorning(now: Date, timezone: string, end: string): Date {
  const since = (secondsOfDay(now, timezone) - secondsOfDay(end) + DAY_SECONDS) % DAY_SECONDS
  return new Date(now.getTime() - since * 1000)
}
```

- [ ] **Step 4: Run the test to see it pass**

Run: `npx vitest run src/modules/messaging/rules.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add src/modules/messaging/rules.ts src/modules/messaging/rules.test.ts
git commit -m "feat: find a contractor's morning, when quiet hours end"
```

---

### Task 2: Recovery text wording

**Files:**
- Create: `src/modules/online-booking/recovery-texts.ts`
- Test: `src/modules/online-booking/recovery-texts.test.ts`

**Interfaces:**
- Produces:
  - `abandonedBookingText(text: { tenantName: string; windows: string[]; link: string }): string`
  - `missedCallerReminderText(text: { tenantName: string; windows: string[]; link: string }): string`
  - `windows` items look like `'Tue, Oct 13 8 AM - 12 PM'` (made in Task 4).

- [ ] **Step 1: Write the failing test**

`src/modules/online-booking/recovery-texts.test.ts`:

```ts
import { expect, it } from 'vitest'
import { abandonedBookingText, missedCallerReminderText } from './recovery-texts.ts'

const WINDOWS = ['Tue, Oct 13 8 AM - 12 PM', 'Tue, Oct 13 12 PM - 4 PM', 'Wed, Oct 14 8 AM - 12 PM']
const LINK = 'https://acme.example/?resume=abc'

it('lists the open times in the abandoned-booking text', () => {
  expect(abandonedBookingText({ tenantName: 'Acme HVAC', windows: WINDOWS, link: LINK })).toBe(
    'Acme HVAC: you started booking a visit. Open times: Tue, Oct 13 8 AM - 12 PM; Tue, Oct 13 12 PM - 4 PM; Wed, Oct 14 8 AM - 12 PM. Finish here: https://acme.example/?resume=abc Reply STOP to opt out.',
  )
})

it('lists only the open times there are', () => {
  expect(
    abandonedBookingText({ tenantName: 'Acme HVAC', windows: WINDOWS.slice(0, 1), link: LINK }),
  ).toBe(
    'Acme HVAC: you started booking a visit. Open times: Tue, Oct 13 8 AM - 12 PM. Finish here: https://acme.example/?resume=abc Reply STOP to opt out.',
  )
})

it('leaves the open times out when none are open', () => {
  expect(abandonedBookingText({ tenantName: 'Acme HVAC', windows: [], link: LINK })).toBe(
    'Acme HVAC: you started booking a visit. Finish here: https://acme.example/?resume=abc Reply STOP to opt out.',
  )
})

it('words the missed-caller reminder the same way', () => {
  expect(missedCallerReminderText({ tenantName: 'Acme HVAC', windows: WINDOWS, link: LINK })).toBe(
    'Acme HVAC: still need a visit? Sorry we missed your call. Open times: Tue, Oct 13 8 AM - 12 PM; Tue, Oct 13 12 PM - 4 PM; Wed, Oct 14 8 AM - 12 PM. Book here: https://acme.example/?resume=abc Reply STOP to opt out.',
  )
  expect(missedCallerReminderText({ tenantName: 'Acme HVAC', windows: [], link: LINK })).toBe(
    'Acme HVAC: still need a visit? Sorry we missed your call. Book here: https://acme.example/?resume=abc Reply STOP to opt out.',
  )
})

it('stays plain ASCII', () => {
  const texts = [
    abandonedBookingText({ tenantName: 'Acme HVAC', windows: WINDOWS, link: LINK }),
    missedCallerReminderText({ tenantName: 'Acme HVAC', windows: WINDOWS, link: LINK }),
  ]
  for (const text of texts) expect(text).toMatch(/^[\x20-\x7e]*$/)
})
```

- [ ] **Step 2: Run the test to see it fail**

Run: `npx vitest run src/modules/online-booking/recovery-texts.test.ts`
Expected: FAIL, cannot find module `./recovery-texts.ts`.

- [ ] **Step 3: Implement**

`src/modules/online-booking/recovery-texts.ts`:

```ts
// The next-morning texts that bring a lead back: a homeowner who stopped partway through
// booking, and a caller nobody answered. Plain ASCII (no en dash, no curly quote), so a text
// stays in the cheaper SMS encoding.

type RecoveryText = {
  tenantName: string
  windows: string[] // 'Tue, Oct 13 8 AM - 12 PM', soonest first; may be empty
  link: string
}

export function abandonedBookingText(text: RecoveryText) {
  return `${text.tenantName}: you started booking a visit.${openTimes(text.windows)} Finish here: ${text.link} Reply STOP to opt out.`
}

export function missedCallerReminderText(text: RecoveryText) {
  return `${text.tenantName}: still need a visit? Sorry we missed your call.${openTimes(text.windows)} Book here: ${text.link} Reply STOP to opt out.`
}

// Left out when nothing is open: the link still shows the calendar.
function openTimes(windows: string[]) {
  return windows.length > 0 ? ` Open times: ${windows.join('; ')}.` : ''
}
```

- [ ] **Step 4: Run the test to see it pass**

Run: `npx vitest run src/modules/online-booking/recovery-texts.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/modules/online-booking/recovery-texts.ts src/modules/online-booking/recovery-texts.test.ts
git commit -m "feat: recovery texts list the open times"
```

---

### Task 3: Safety stop on the draft (API)

**Files:**
- Modify: `src/db/schema.ts` (`bookingDrafts`, after `recoveryTextedAt`)
- Create: `drizzle/0018_draft_safety_stop.sql` and its `drizzle/meta` snapshot (generated)
- Modify: `src/modules/online-booking/online-booking.queries.ts` (`updateDraft`, new `setDraftSafetyStop`)
- Modify: `src/modules/online-booking/online-booking.service.ts` (`saveDraftAnswers`, new `stopDraftForSafety`)
- Modify: `src/modules/online-booking/online-booking.routes.ts` (new route after the `PATCH /online-booking/drafts/:token` route)
- Test: `src/modules/online-booking/booking-drafts.test.ts`

**Interfaces:**
- Produces:
  - Column `bookingDrafts.safetyStoppedAt` (`safety_stopped_at timestamptz`, null = not stopped). Task 4 filters on it.
  - `POST /api/online-booking/drafts/:token/safety-stop` → `200 { ok: true }`; `404` for an unknown, booked or other contractor's draft. Task 6 calls it.
  - `onlineBooking.stopDraftForSafety(tenantId: string, token: string): Promise<void>`

- [ ] **Step 1: Write the failing tests**

In `src/modules/online-booking/booking-drafts.test.ts`, add this `describe` block right after the `describe('GET and PATCH /api/online-booking/drafts/:token', ...)` block (`auditEvents` is already imported):

```ts
describe('POST /api/online-booking/drafts/:token/safety-stop', () => {
  it('marks the draft so it is never texted, and logs it', async () => {
    await createServingShop()
    const { body } = await call('post', 'drafts').send(draftBody()).expect(201)
    const [before] = await db.select().from(bookingDrafts)

    await call('post', `drafts/${body.token}/safety-stop`).expect(200, { ok: true })

    const [draft] = await db.select().from(bookingDrafts)
    expect(draft.safetyStoppedAt).toBeInstanceOf(Date)
    // Not homeowner activity: the recovery wait isn't restarted.
    expect(draft.lastActivityAt).toEqual(before.lastActivityAt)
    const logged = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'booking_draft.safety_stopped'))
    expect(logged).toHaveLength(1)
    expect(logged[0]).toMatchObject({ actorType: 'homeowner', entityId: draft.id })
  })

  it('is cleared once the homeowner says they are safe and describes the problem', async () => {
    await createServingShop()
    const { body } = await call('post', 'drafts').send(draftBody()).expect(201)
    await call('post', `drafts/${body.token}/safety-stop`).expect(200)

    // Saving other answers leaves it: only finishing step 4 shows it was a mistake.
    await call('patch', `drafts/${body.token}`)
      .send({ answers: { bookedVia: 'google' } })
      .expect(200)
    expect((await db.select().from(bookingDrafts))[0].safetyStoppedAt).toBeInstanceOf(Date)

    await call('patch', `drafts/${body.token}`)
      .send({ answers: { problem: 'No cooling', systemType: 'central_ac' } })
      .expect(200)
    expect((await db.select().from(bookingDrafts))[0].safetyStoppedAt).toBeNull()
  })

  it('hides an unknown, booked or other contractor’s draft', async () => {
    const shop = await createServingShop()
    await createServingShop('other')
    const { body } = await call('post', 'drafts').send(draftBody()).expect(201)

    await call('post', 'drafts/nope/safety-stop').expect(404)
    await call('post', `drafts/${body.token}/safety-stop`, 'other').expect(404)

    await call('post', 'bookings')
      .send(bookingBody(shop, { draftToken: body.token }))
      .expect(201)
    await call('post', `drafts/${body.token}/safety-stop`).expect(404)
  })
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run src/modules/online-booking/booking-drafts.test.ts -t "safety-stop"`
Expected: FAIL, the route answers 404 for a known draft, and `safetyStoppedAt` is undefined.

- [ ] **Step 3: Add the column and generate the migration**

In `src/db/schema.ts`, in `bookingDrafts`, right after the `recoveryTextedAt` line:

```ts
    // Reached the gas / carbon monoxide safety screen: never texted to finish booking.
    // Cleared once the homeowner finishes step 4 after all ("I tapped Yes by mistake").
    safetyStoppedAt: timestamptz('safety_stopped_at'),
```

Run: `npx drizzle-kit generate --name draft_safety_stop`
Expected: it writes `drizzle/0018_draft_safety_stop.sql` containing exactly:

```sql
ALTER TABLE "booking_drafts" ADD COLUMN "safety_stopped_at" timestamp with time zone;
```

and updates `drizzle/meta/_journal.json` plus a new `drizzle/meta/0018_snapshot.json`. If the SQL has anything else in it, stop: the schema and the migrations had drifted before this change.

- [ ] **Step 4: Queries**

In `src/modules/online-booking/online-booking.queries.ts`, widen `updateDraft`'s `values` type so it can clear the stop:

```ts
export async function updateDraft(
  tenantId: string,
  draftId: string,
  values: Partial<
    Pick<
      typeof bookingDrafts.$inferInsert,
      'name' | 'phone' | 'zip' | 'smsConsent' | 'answers' | 'safetyStoppedAt'
    >
  >,
  tx: Db = db,
) {
```

(the body stays the same). Add right after `updateDraft`:

```ts
// The safety screen showed. Not something the homeowner changed, so the recovery wait goes on.
export async function setDraftSafetyStop(tenantId: string, draftId: string, tx: Db) {
  await tx
    .update(bookingDrafts)
    .set({ safetyStoppedAt: new Date() })
    .where(and(eq(bookingDrafts.tenantId, tenantId), eq(bookingDrafts.id, draftId)))
}
```

- [ ] **Step 5: Service**

In `src/modules/online-booking/online-booking.service.ts`, replace `saveDraftAnswers` with:

```ts
// After each later step: replaces the draft's answers. Answers with a problem mean the
// homeowner got past the safety question, so an earlier safety stop was a mistake.
export async function saveDraftAnswers(tenantId: string, token: string, answers: DraftAnswers) {
  const draft = await queries.findOpenDraft(tenantId, token)
  if (!draft) throw new HttpError(404, 'not_found', DRAFT_GONE)
  await queries.updateDraft(
    tenantId,
    draft.id,
    answers.problem ? { answers, safetyStoppedAt: null } : { answers },
  )
}

// Step 4's safety screen: someone who smells gas or has a carbon monoxide alarm is told not to
// book online, so their draft must never get a "finish your booking" text.
export async function stopDraftForSafety(tenantId: string, token: string) {
  await db.transaction(async (tx) => {
    const draft = await queries.findOpenDraft(tenantId, token, tx)
    if (!draft) throw new HttpError(404, 'not_found', DRAFT_GONE)
    await queries.setDraftSafetyStop(tenantId, draft.id, tx)
    await audit.insertHomeownerAction(
      tenantId,
      { action: 'booking_draft.safety_stopped', entityType: 'booking_draft', entityId: draft.id },
      tx,
    )
  })
}
```

- [ ] **Step 6: Route**

In `src/modules/online-booking/online-booking.routes.ts`, right after the `onlineBookingRoutes.patch('/online-booking/drafts/:token', ...)` block:

```ts
onlineBookingRoutes.post(
  '/online-booking/drafts/:token/safety-stop',
  draftLimit,
  tenantFromHost,
  async (req, res) => {
    await onlineBooking.stopDraftForSafety(req.tenant!.id, String(req.params.token))
    res.json({ ok: true })
  },
)
```

- [ ] **Step 7: Run the tests to see them pass**

Run: `npx vitest run src/modules/online-booking/booking-drafts.test.ts`
Expected: PASS, the whole file (the old tests too).

- [ ] **Step 8: Typecheck and commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add src/db/schema.ts drizzle/0018_draft_safety_stop.sql drizzle/meta src/modules/online-booking/online-booking.queries.ts src/modules/online-booking/online-booking.service.ts src/modules/online-booking/online-booking.routes.ts src/modules/online-booking/booking-drafts.test.ts
git commit -m "feat: a draft that reached the gas safety stop is marked"
```

---

### Task 4: Next-morning abandoned-booking text

**Files:**
- Create: `src/modules/online-booking/recovery.ts`
- Modify: `src/modules/online-booking/online-booking.queries.ts` (new `listRecoveryTenants`, rewrite `listDraftsToRecover`, header comment)
- Modify: `src/modules/online-booking/online-booking.service.ts` (constants, `sendRecoveryTexts`)
- Modify: `test/helpers.ts` (new `setMorning`, `setQuietNow`)
- Test: `src/modules/online-booking/booking-drafts.test.ts` (the `sendRecoveryTexts` block)

**Interfaces:**
- Consumes: `lastMorning`, `quietUntil` (Task 1, `messaging/rules.ts`); `abandonedBookingText` (Task 2); `bookingDrafts.safetyStoppedAt` (Task 3).
- Produces:
  - `recovery.listDueTenants(now?: Date): Promise<DueTenant[]>`, where `DueTenant = { id: string; name: string; slug: string; customDomain: string | null; customDomainVerifiedAt: Date | null; timezone: string; quietHoursStart: string; quietHoursEnd: string; since: Date; before: Date }`. A lead is due when its moment is `>= since` and `< before`.
  - `recovery.nextOpenWindows(tenantId: string): Promise<string[]>`, at most 3, like `'Tue, Oct 13 8 AM - 12 PM'`.
  - Test helpers `setMorning(tenantId: string, minutesAgo: number)` and `setQuietNow(tenantId: string)`. Task 5 uses them.
  - `sendRecoveryTexts(now?: Date): Promise<number>` (same name, used by `jobs/index.ts`).

- [ ] **Step 1: Test helpers**

In `test/helpers.ts`, add at the end:

```ts
// Phoenix wall-clock time `offsetMinutes` from now, as '13:05:42'. Phoenix has no daylight
// saving, so local time is always UTC-7.
function phoenixClock(offsetMinutes: number) {
  return new Date(Date.now() - 7 * 3_600_000 + offsetMinutes * 60_000).toISOString().slice(11, 19)
}

// Sets quiet hours so the contractor's morning (when they end) was `minutesAgo` minutes ago
// and they start again in an hour: the lead-recovery job runs for it right now, whatever the
// time of day the tests run.
export async function setMorning(tenantId: string, minutesAgo: number) {
  await db
    .update(tenants)
    .set({ quietHoursEnd: phoenixClock(-minutesAgo), quietHoursStart: phoenixClock(60) })
    .where(eq(tenants.id, tenantId))
}

// Sets quiet hours to the hour around now: no unprompted text may go out.
export async function setQuietNow(tenantId: string) {
  await db
    .update(tenants)
    .set({ quietHoursStart: phoenixClock(-60), quietHoursEnd: phoenixClock(60) })
    .where(eq(tenants.id, tenantId))
}
```

- [ ] **Step 2: Write the failing tests**

In `src/modules/online-booking/booking-drafts.test.ts`:

Change the helpers import to:

```ts
import {
  createJob,
  createShop,
  resetDb,
  type Shop,
  setMorning,
  setQuietNow,
  TUESDAY,
} from '../../../test/helpers.ts'
```

Replace the `insertDraft` comment and defaults (keep the rest of the function):

```ts
// A draft straight in the database: consent given, quiet for 5 hours, begun 6 hours ago. With
// the morning 3 hours ago (setMorning), that is one the recovery job should text.
async function insertDraft(
  shop: Shop,
  token: string,
  overrides: Partial<typeof bookingDrafts.$inferInsert> = {},
) {
  await db.insert(bookingDrafts).values({
    tenantId: shop.tenant.id,
    token,
    name: 'Sam Reed',
    phone: '+14805550199',
    zip: '85201',
    smsConsent: true,
    lastActivityAt: minutesAgo(5 * 60),
    createdAt: minutesAgo(6 * 60),
    ...overrides,
  })
```

Replace the whole `describe('sendRecoveryTexts', ...)` block with:

```ts
describe('sendRecoveryTexts', () => {
  it('saves one text with the open times and a link back, and never a second one', async () => {
    const shop = await createServingShop()
    await setMorning(shop.tenant.id, 180)
    await insertDraft(shop, 'token-1')

    expect(await sendRecoveryTexts()).toBe(1)

    const saved = await db.select().from(messages)
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({
      tenantId: shop.tenant.id,
      channel: 'sms',
      direction: 'outbound',
      kind: 'abandoned_booking',
      status: 'queued',
      contact: '+14805550199',
    })
    expect(saved[0].body).toMatch(/^desert HVAC: you started booking a visit\. Open times: /)
    // The shop has 8-12 and 12-4 windows on Tuesdays and Wednesdays: three of them are listed.
    expect(saved[0].body.match(/\d{1,2} (AM|PM) - \d{1,2} (AM|PM)/g)).toHaveLength(3)
    expect(saved[0].body).toContain('https://desert.localhost/?resume=token-1')
    expect(saved[0].body).toMatch(/^[\x20-\x7e]*$/)
    const [draft] = await db.select().from(bookingDrafts)
    expect(draft.recoveryTextedAt).toBeInstanceOf(Date)

    expect(await sendRecoveryTexts()).toBe(0)
    expect(await db.select().from(messages)).toHaveLength(1)
  })

  it('does not text the homeowners of a suspended contractor', async () => {
    const live = await createServingShop('desert')
    const off = await createServingShop('gone')
    await setMorning(live.tenant.id, 180)
    await setMorning(off.tenant.id, 180)
    await insertDraft(live, 'live-token')
    await insertDraft(off, 'off-token')
    await db.update(tenants).set({ status: 'suspended' }).where(eq(tenants.id, off.tenant.id))

    expect(await sendRecoveryTexts()).toBe(1)

    const saved = await db.select().from(messages)
    expect(saved).toHaveLength(1)
    expect(saved[0].tenantId).toBe(live.tenant.id)
  })

  it('leaves alone every draft that must not be texted', async () => {
    const shop = await createServingShop()
    await setMorning(shop.tenant.id, 180)
    const job = await createJob(shop) // made just now, for the customer with phone +16025550111

    await insertDraft(shop, 'no-consent', { smsConsent: false })
    await insertDraft(shop, 'booked', { bookedJobId: job.id })
    await insertDraft(shop, 'booked-by-phone', { phone: '+16025550111' })
    await insertDraft(shop, 'safety-stopped', { safetyStoppedAt: minutesAgo(5 * 60) })
    // Active after the morning: its morning is tomorrow.
    await insertDraft(shop, 'active-after-morning', { lastActivityAt: minutesAgo(120) })
    // Older than the previous morning: its one chance was yesterday.
    await insertDraft(shop, 'older-than-previous-morning', {
      lastActivityAt: minutesAgo(28 * 60),
      createdAt: minutesAgo(29 * 60),
    })

    expect(await sendRecoveryTexts()).toBe(0)
    expect(await db.select().from(messages)).toHaveLength(0)
  })

  it('waits an hour after the homeowner stopped, even past the morning', async () => {
    const shop = await createServingShop()
    await setMorning(shop.tenant.id, 30)
    // Stopped 40 minutes ago, before this morning began.
    await insertDraft(shop, 'just-stopped', { lastActivityAt: minutesAgo(40) })

    expect(await sendRecoveryTexts()).toBe(0)

    await db.update(bookingDrafts).set({ lastActivityAt: minutesAgo(61) })
    expect(await sendRecoveryTexts()).toBe(1)
  })

  it('texts nobody while the contractor is in quiet hours', async () => {
    const shop = await createServingShop()
    await setQuietNow(shop.tenant.id)
    await insertDraft(shop, 'token-1', { lastActivityAt: minutesAgo(20 * 60) })

    expect(await sendRecoveryTexts()).toBe(0)
    expect(await db.select().from(messages)).toHaveLength(0)
  })
})
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `npx vitest run src/modules/online-booking/booking-drafts.test.ts -t "sendRecoveryTexts"`
Expected: FAIL. The first test fails on the body (no `Open times:`), "leaves alone" fails on `safety-stopped` and `older-than-previous-morning`, and the quiet-hours test fails (today's code texts at any hour).

- [ ] **Step 4: Queries**

In `src/modules/online-booking/online-booking.queries.ts`:

Change the drizzle import to (adds `gte`):

```ts
import { and, asc, eq, gt, gte, inArray, isNull, lt, ne, sql } from 'drizzle-orm'
```

Change the header comment's second sentence to:

```ts
// Tenant-scoped: every query takes tenantId first, except the system jobs' queries
// (expireHolds, listRecoveryTenants, deleteIdleDraftPhotos) and findDraftPhoto, which work
// across contractors.
```

Replace the whole `listDraftsToRecover` function (and its comment) with:

```ts
// Every turned-on contractor, with what the lead-recovery job needs to know when its morning
// is and to build links.
export function listRecoveryTenants() {
  return db
    .select({
      id: tenants.id,
      name: tenants.name,
      slug: tenants.slug,
      customDomain: tenants.customDomain,
      customDomainVerifiedAt: tenants.customDomainVerifiedAt,
      timezone: tenants.timezone,
      quietHoursStart: tenants.quietHoursStart,
      quietHoursEnd: tenants.quietHoursEnd,
    })
    .from(tenants)
    .where(ne(tenants.status, 'suspended'))
}

// The contractor's drafts due their one recovery text: consent given, last touched in the
// range, not booked, not texted yet, not stopped for safety, and no job made for that phone
// since the draft began (they may have called the office instead).
export function listDraftsToRecover(tenantId: string, range: { since: Date; before: Date }) {
  return db
    .select({ id: bookingDrafts.id, token: bookingDrafts.token, phone: bookingDrafts.phone })
    .from(bookingDrafts)
    .where(
      and(
        eq(bookingDrafts.tenantId, tenantId),
        eq(bookingDrafts.smsConsent, true),
        isNull(bookingDrafts.bookedJobId),
        isNull(bookingDrafts.recoveryTextedAt),
        isNull(bookingDrafts.safetyStoppedAt),
        gte(bookingDrafts.lastActivityAt, range.since),
        lt(bookingDrafts.lastActivityAt, range.before),
        sql`not exists (
          select 1 from ${jobs}
          join ${customers} on ${customers.id} = ${jobs.customerId}
          where ${jobs.tenantId} = ${bookingDrafts.tenantId}
            and ${customers.phone} = ${bookingDrafts.phone}
            and ${jobs.createdAt} > ${bookingDrafts.createdAt}
        )`,
      ),
    )
}
```

If Biome or TypeScript then reports `gt` as unused, remove it from the import.

- [ ] **Step 5: `recovery.ts`**

`src/modules/online-booking/recovery.ts`:

```ts
import { formatDay, formatTime } from '../../lib/labels.ts'
import { lastMorning, quietUntil } from '../messaging/rules.ts'
import * as queries from './online-booking.queries.ts'

// What the next-morning lead-recovery texts share: a homeowner who stopped partway through
// booking, and a caller nobody answered, each get one text on the first morning after.
// "Morning" is when the contractor's quiet hours end. The texts are written then, during the
// contractor's day, so the open times they list are still open.

const WAIT_MINUTES = 60 // a lead quiet less than this isn't texted yet, even past the morning
const DAYS_AHEAD = 14 // the booking calendar's two weeks
const OPEN_TIMES = 3

export type DueTenant = Awaited<ReturnType<typeof queries.listRecoveryTenants>>[number] & {
  since: Date
  before: Date
}

// Contractors whose morning has begun and who aren't in quiet hours, each with the range of
// leads due today: from the previous morning up to this morning (and at least WAIT_MINUTES
// ago). Each lead falls in one day's range only, so a job that was down all day skips it
// rather than texting it a day late.
export async function listDueTenants(now = new Date()): Promise<DueTenant[]> {
  const due: DueTenant[] = []
  for (const tenant of await queries.listRecoveryTenants()) {
    if (quietUntil(now, tenant.timezone, tenant.quietHoursStart, tenant.quietHoursEnd)) continue
    const morning = lastMorning(now, tenant.timezone, tenant.quietHoursEnd)
    due.push({
      ...tenant,
      since: new Date(morning.getTime() - 24 * 3_600_000),
      before: new Date(Math.min(morning.getTime(), now.getTime() - WAIT_MINUTES * 60_000)),
    })
  }
  return due
}

// The first open arrival windows, as a text lists them: 'Tue, Oct 13 8 AM - 12 PM'. A plain
// hyphen, not formatWindow's en dash, which would switch the text to Unicode.
export async function nextOpenWindows(tenantId: string) {
  const rows = await queries.listOpenWindows(tenantId, DAYS_AHEAD)
  return rows
    .slice(0, OPEN_TIMES)
    .map((row) => `${formatDay(row.date)} ${formatTime(row.startsAt)} - ${formatTime(row.endsAt)}`)
}
```

- [ ] **Step 6: Service**

In `src/modules/online-booking/online-booking.service.ts`:

Delete these lines:

```ts
// Recovery text: sent once a draft has been quiet this long, and never for one begun longer
// ago than the cutoff. Still to decide: whether contractors set these themselves.
const RECOVERY_WAIT_MINUTES = 60
const RECOVERY_CUTOFF_HOURS = 24

```

Add these imports (keep the import list sorted the way Biome wants; `npm run format` fixes the order):

```ts
import * as recovery from './recovery.ts'
import { abandonedBookingText } from './recovery-texts.ts'
```

Replace `sendRecoveryTexts` (and its comment) with:

```ts
// Run every 5 minutes by the 'booking-recovery' job: homeowners who agreed to texts and stopped
// partway get one text the next morning, with the open times and a link back to their draft.
// Returns how many were texted.
export async function sendRecoveryTexts(now = new Date()) {
  let texted = 0
  for (const tenant of await recovery.listDueTenants(now)) {
    const drafts = await queries.listDraftsToRecover(tenant.id, tenant)
    if (drafts.length === 0) continue
    const windows = await recovery.nextOpenWindows(tenant.id)
    for (const draft of drafts) {
      // Together, so a draft is never marked without its text, and never texted twice.
      await db.transaction(async (tx) => {
        await sendText(
          tenant.id,
          {
            contact: draft.phone,
            kind: 'abandoned_booking',
            body: abandonedBookingText({
              tenantName: tenant.name,
              windows,
              link: bookingLink(tenant, draft.token),
            }),
          },
          tx,
        )
        await queries.markDraftTexted(tenant.id, draft.id, tx)
      })
    }
    texted += drafts.length
  }
  return texted
}
```

- [ ] **Step 7: Run the tests to see them pass**

Run: `npx vitest run src/modules/online-booking/booking-drafts.test.ts`
Expected: PASS, the whole file.

- [ ] **Step 8: Typecheck, lint, commit**

Run: `npm run typecheck` then `npm run lint`
Expected: both clean. If lint only complains about import order or formatting, run `npm run format` and check again.

```bash
git add test/helpers.ts src/modules/online-booking/recovery.ts src/modules/online-booking/online-booking.queries.ts src/modules/online-booking/online-booking.service.ts src/modules/online-booking/booking-drafts.test.ts
git commit -m "feat: abandoned-booking text goes the next morning with three open times"
```

---

### Task 5: Missed-caller reminder

**Files:**
- Modify: `src/modules/calls/calls.queries.ts` (new `listCallersToRemind`)
- Modify: `src/modules/calls/calls.service.ts` (new `sendMissedCallerReminders`, shared `callLink`)
- Modify: `src/jobs/index.ts` (`booking-recovery` job)
- Test: `src/modules/calls/missed-caller-reminders.test.ts` (new)

**Interfaces:**
- Consumes: `recovery.listDueTenants`, `recovery.nextOpenWindows`, `DueTenant` (Task 4); `missedCallerReminderText` (Task 2); `setMorning`, `setQuietNow` (Task 4, `test/helpers.ts`).
- Produces: `sendMissedCallerReminders(now?: Date): Promise<number>` in `calls.service.ts`.

- [ ] **Step 1: Write the failing tests**

`src/modules/calls/missed-caller-reminders.test.ts`:

```ts
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  createJob,
  createShop,
  resetDb,
  type Shop,
  setMorning,
  setQuietNow,
} from '../../../test/helpers.ts'
import { db } from '../../db/client.ts'
import { bookingDrafts, calls, consentEvents, messages } from '../../db/schema.ts'
import { sendMissedCallerReminders } from './calls.service.ts'

// The shop's customer, so a job made with createJob counts as this caller's booking.
const CALLER = '+16025550111'

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000)

beforeEach(resetDb)

// A shop whose morning was 3 hours ago: calls from 27 to 3 hours ago are due a reminder.
async function morningShop(slug = 'desert') {
  const shop = await createShop(slug)
  await setMorning(shop.tenant.id, 180)
  return shop
}

// Missed 5 hours ago, before this morning, unless told otherwise.
async function missedCall(shop: Shop, values: Partial<typeof calls.$inferInsert> = {}) {
  const [row] = await db
    .insert(calls)
    .values({
      tenantId: shop.tenant.id,
      providerSid: randomUUID(),
      fromPhone: CALLER,
      toPhone: '+14805550100',
      startedAt: minutesAgo(5 * 60),
      ...values,
    })
    .returning()
  return row
}

async function consent(shop: Shop, granted: boolean, at = minutesAgo(30 * 24 * 60)) {
  await db.insert(consentEvents).values({
    tenantId: shop.tenant.id,
    contact: CALLER,
    channel: 'sms',
    granted,
    source: 'booking_form',
    createdAt: at,
  })
}

function reminders() {
  return db.select().from(messages).where(eq(messages.kind, 'missed_caller_reminder'))
}

describe('sendMissedCallerReminders', () => {
  it('texts a caller who agreed to texts once, with the open times and the call link', async () => {
    const shop = await morningShop()
    await consent(shop, true)
    const missed = await missedCall(shop)

    expect(await sendMissedCallerReminders()).toBe(1)

    const [text] = await reminders()
    expect(text).toMatchObject({
      tenantId: shop.tenant.id,
      contact: CALLER,
      status: 'queued',
      callId: missed.id,
    })
    expect(text.body).toMatch(/^desert HVAC: still need a visit\? Sorry we missed your call\. /)
    expect(text.body.match(/\d{1,2} (AM|PM) - \d{1,2} (AM|PM)/g)).toHaveLength(3)
    expect(text.body).toContain(
      `https://desert.localhost/?call=${missed.id}&phone=%2B16025550111`,
    )

    // At most one a week.
    expect(await sendMissedCallerReminders()).toBe(0)
    expect(await reminders()).toHaveLength(1)
  })

  it('sends one text for several missed calls, about the latest', async () => {
    const shop = await morningShop()
    await consent(shop, true)
    await missedCall(shop, { startedAt: minutesAgo(6 * 60) })
    const latest = await missedCall(shop, { startedAt: minutesAgo(5 * 60) })

    expect(await sendMissedCallerReminders()).toBe(1)
    expect((await reminders())[0].callId).toBe(latest.id)
  })

  it('never texts a caller without consent, or one who opted out', async () => {
    const shop = await morningShop()
    await missedCall(shop)
    expect(await sendMissedCallerReminders()).toBe(0)

    await consent(shop, true, minutesAgo(10 * 24 * 60))
    await consent(shop, false, minutesAgo(24 * 60)) // texted STOP since
    expect(await sendMissedCallerReminders()).toBe(0)
    expect(await db.select().from(messages)).toHaveLength(0)
  })

  it('leaves alone a caller who booked, started online, got through or texted in', async () => {
    for (const after of ['booked', 'draft', 'answered', 'texted'] as const) {
      await resetDb()
      const shop = await morningShop()
      await consent(shop, true)
      await missedCall(shop)

      if (after === 'booked') await createJob(shop)
      if (after === 'draft') {
        await db.insert(bookingDrafts).values({
          tenantId: shop.tenant.id,
          token: randomUUID(),
          name: 'Maria Lopez',
          phone: CALLER,
          zip: '85004',
          createdAt: minutesAgo(4 * 60),
        })
      }
      if (after === 'answered') {
        await missedCall(shop, { answeredBy: 'office', startedAt: minutesAgo(4 * 60) })
      }
      if (after === 'texted') {
        await db.insert(messages).values({
          tenantId: shop.tenant.id,
          channel: 'sms',
          direction: 'inbound',
          contact: CALLER,
          kind: 'inbound',
          body: 'Can you come Friday?',
          status: 'received',
        })
      }

      expect(await sendMissedCallerReminders(), after).toBe(0)
    }
  })

  it('waits a week after the last reminder', async () => {
    const shop = await morningShop()
    await consent(shop, true)
    await missedCall(shop)
    await db.insert(messages).values({
      tenantId: shop.tenant.id,
      channel: 'sms',
      direction: 'outbound',
      contact: CALLER,
      kind: 'missed_caller_reminder',
      body: 'earlier reminder',
      status: 'delivered',
      createdAt: minutesAgo(3 * 24 * 60),
    })

    expect(await sendMissedCallerReminders()).toBe(0)
  })

  it('only texts calls from the previous morning up to this one', async () => {
    const shop = await morningShop()
    await consent(shop, true)
    await missedCall(shop, { startedAt: minutesAgo(120) }) // after this morning: tomorrow
    await missedCall(shop, { startedAt: minutesAgo(28 * 60) }) // before the previous morning
    await missedCall(shop, { fromPhone: null }) // caller ID hidden

    expect(await sendMissedCallerReminders()).toBe(0)
  })

  it('texts nobody while the contractor is in quiet hours', async () => {
    const shop = await createShop('desert')
    await setQuietNow(shop.tenant.id)
    await consent(shop, true)
    await missedCall(shop, { startedAt: minutesAgo(20 * 60) })

    expect(await sendMissedCallerReminders()).toBe(0)
  })
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run src/modules/calls/missed-caller-reminders.test.ts`
Expected: FAIL, `sendMissedCallerReminders` is not exported.

- [ ] **Step 3: Query**

In `src/modules/calls/calls.queries.ts`, change the drizzle import to add `sql`:

```ts
import { and, eq, gte, isNull, ne, sql } from 'drizzle-orm'
```

Add at the end of the file:

```ts
// The contractor's missed callers due their one next-morning reminder: one row per phone, the
// latest missed call in the range. Only callers whose latest answer to texts is yes (the
// reminder needs consent, and asking here keeps blocked rows out of the messages), who haven't
// booked, started a booking online (that draft gets its own text), got through on a later call
// or texted in since, and weren't reminded since `remindedSince`.
export async function listCallersToRemind(
  tenantId: string,
  range: { since: Date; before: Date; remindedSince: Date },
) {
  const result = await db.execute<{ id: string; phone: string; customerId: string | null }>(sql`
    select distinct on (c.from_phone) c.id, c.from_phone as "phone", c.customer_id as "customerId"
    from calls c
    where c.tenant_id = ${tenantId}
      and c.answered_by is null
      and c.from_phone is not null
      and c.started_at >= ${range.since.toISOString()}
      and c.started_at < ${range.before.toISOString()}
      and (
        select e.granted from consent_events e
        where e.tenant_id = c.tenant_id and e.contact = c.from_phone and e.channel = 'sms'
        order by e.created_at desc
        limit 1
      ) is true
      and not exists (
        select 1 from jobs j
        join customers cu on cu.id = j.customer_id
        where j.tenant_id = c.tenant_id and cu.phone = c.from_phone
          and j.created_at > c.started_at
      )
      and not exists (
        select 1 from booking_drafts d
        where d.tenant_id = c.tenant_id and d.phone = c.from_phone
          and d.created_at > c.started_at
      )
      and not exists (
        select 1 from calls a
        where a.tenant_id = c.tenant_id and a.from_phone = c.from_phone
          and a.answered_by is not null and a.started_at > c.started_at
      )
      and not exists (
        select 1 from messages m
        where m.tenant_id = c.tenant_id and m.contact = c.from_phone
          and m.direction = 'inbound' and m.created_at > c.started_at
      )
      and not exists (
        select 1 from messages m
        where m.tenant_id = c.tenant_id and m.contact = c.from_phone
          and m.kind = 'missed_caller_reminder'
          and m.created_at > ${range.remindedSince.toISOString()}
      )
    order by c.from_phone, c.started_at desc
  `)
  return result.rows
}
```

- [ ] **Step 4: Service**

Replace `src/modules/calls/calls.service.ts` with:

```ts
import type { Tx } from '../../db/client.ts'
import { tenantUrl } from '../../lib/tenant-url.ts'
import { sendText } from '../messaging/sms.ts'
import * as recovery from '../online-booking/recovery.ts'
import { missedCallerReminderText } from '../online-booking/recovery-texts.ts'
import * as queries from './calls.queries.ts'

// At most one text-back per caller in this window, however many times they ring.
const TEXT_BACK_GAP_HOURS = 12

// At most one next-morning reminder per caller in this many days.
const REMINDER_GAP_DAYS = 7

// Texts a caller nobody answered a link to book online. Runs in the transaction that saved
// the call, so the call and its text are saved together. Any provider's webhook (httpSMS
// today, Twilio later) calls this once it has saved a missed call.
export async function textBackMissedCall(tenantId: string, callId: string, tx: Tx) {
  const call = await queries.findMissedCall(tenantId, callId, tx)
  if (!call?.fromPhone) return // answered, or caller ID hidden: nobody to text

  const since = new Date(Date.now() - TEXT_BACK_GAP_HOURS * 3_600_000)
  if (await queries.textedBackSince(tenantId, call.fromPhone, since, tx)) return

  await sendText(
    tenantId,
    {
      contact: call.fromPhone,
      kind: 'text_back',
      body: `${call.tenant.name}: sorry we missed your call. Book a visit here: ${callLink(call.tenant, call.id, call.fromPhone)} Reply STOP to opt out.`,
      callId: call.id,
      customerId: call.customerId ?? undefined,
    },
    tx,
  )
}

// Run every 5 minutes by the 'booking-recovery' job: a missed caller who agreed to texts and
// hasn't booked gets one text the next morning, with the open times. Returns how many.
export async function sendMissedCallerReminders(now = new Date()) {
  const remindedSince = new Date(now.getTime() - REMINDER_GAP_DAYS * 24 * 3_600_000)
  let reminded = 0
  for (const tenant of await recovery.listDueTenants(now)) {
    const callers = await queries.listCallersToRemind(tenant.id, { ...tenant, remindedSince })
    if (callers.length === 0) continue
    const windows = await recovery.nextOpenWindows(tenant.id)
    for (const caller of callers) {
      // The saved text, with its call, is the record that this caller was reminded.
      await sendText(tenant.id, {
        contact: caller.phone,
        kind: 'missed_caller_reminder',
        body: missedCallerReminderText({
          tenantName: tenant.name,
          windows,
          link: callLink(tenant, caller.id, caller.phone),
        }),
        callId: caller.id,
        customerId: caller.customerId ?? undefined,
      })
    }
    reminded += callers.length
  }
  return reminded
}

// The booking page for a missed caller: `call` lets the booking count as recovered; `phone`
// fills in the contact step.
function callLink(
  tenant: { slug: string; customDomain: string | null; customDomainVerifiedAt: Date | null },
  callId: string,
  phone: string,
) {
  return tenantUrl(tenant, `/?call=${callId}&phone=${encodeURIComponent(phone)}`)
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `npx vitest run src/modules/calls`
Expected: PASS, the new file and the existing `calls.test.ts` (the text-back link is unchanged).

- [ ] **Step 6: Run both senders from the job**

In `src/jobs/index.ts`, add the import (sorted with the others):

```ts
import * as calls from '../modules/calls/calls.service.ts'
```

Replace the `booking-recovery` registration with:

```ts
  // Every 5 minutes: once a contractor's morning begins, homeowners who stopped partway through
  // booking and missed callers who didn't book get one text each.
  await register('booking-recovery', { cron: '*/5 * * * *' }, async () => {
    const texted = await onlineBooking.sendRecoveryTexts()
    const reminded = await calls.sendMissedCallerReminders()
    if (texted > 0 || reminded > 0) logger.info({ texted, reminded }, 'Lead recovery texts saved')
  })
```

- [ ] **Step 7: Typecheck, lint, commit**

Run: `npm run typecheck` then `npm run lint`
Expected: both clean (`npm run format` for import order only).

```bash
git add src/modules/calls/calls.queries.ts src/modules/calls/calls.service.ts src/modules/calls/missed-caller-reminders.test.ts src/jobs/index.ts
git commit -m "feat: missed callers who didn't book get a reminder the next morning"
```

---

### Task 6: Safety screen marks the draft (web)

**Files (repo `relay-web`):**
- Modify: `src/features/booking/api.ts` (new hook after `useSaveDraftAnswers`)
- Modify: `src/features/booking/problem-step.tsx` (`SafetyStop` and where it is rendered)

**Interfaces:**
- Consumes: `POST /api/online-booking/drafts/:token/safety-stop` → `{ ok: true }` (Task 3).
- Produces: `useStopDraftForSafety()` (TanStack mutation taking the draft token).

- [ ] **Step 1: Branch**

```bash
cd ../relay-web
git checkout main
git pull
git checkout -b feat/lead-recovery
```

- [ ] **Step 2: API hook**

In `src/features/booking/api.ts`, right after `useSaveDraftAnswers`:

```ts
// Step 4's gas / carbon monoxide safety screen showed: the draft is never texted to finish
// booking. A failure is ignored, like the answers save: the safety message comes first.
export function useStopDraftForSafety() {
  return useMutation({
    mutationFn: (token: string) =>
      api.post(`/online-booking/drafts/${token}/safety-stop`, {}, Sent),
  })
}
```

- [ ] **Step 3: Call it from the safety screen**

In `src/features/booking/problem-step.tsx`:

Change `import { type FormEvent, useState } from 'react'` to:

```ts
import { type FormEvent, useEffect, useState } from 'react'
```

Change `import { useDraftPhotos } from './api'` to:

```ts
import { useDraftPhotos, useStopDraftForSafety } from './api'
```

Change the line `if (gas === 'yes') return <SafetyStop onMistake={() => setGas(null)} />` to:

```tsx
  if (gas === 'yes') return <SafetyStop draftToken={draftToken} onMistake={() => setGas(null)} />
```

Replace the start of `SafetyStop`, up to and including `return (`, with:

```tsx
// Showing it marks the draft, so the homeowner never gets a "finish your booking" text after
// being told not to book online. Finishing step 4 after "I tapped Yes by mistake" clears it.
function SafetyStop({ draftToken, onMistake }: { draftToken: string; onMistake: () => void }) {
  const { mutate: stopDraft } = useStopDraftForSafety()
  useEffect(() => {
    if (draftToken) stopDraft(draftToken)
  }, [draftToken, stopDraft])

  return (
```

(the JSX below stays as it is).

- [ ] **Step 4: Check**

Run: `npm run typecheck`, `npm run lint`, `npm test`
Expected: all clean; the existing tests still pass.

- [ ] **Step 5: Try it by hand**

With `relay-api` (`npm run dev`) and `relay-web` (`npm run dev`) running against the dev database, open the booking page, go through ZIP and contact (consent ticked), answer "Yes" to the gas question, and check in the browser's network tab that exactly one `POST /api/online-booking/drafts/<token>/safety-stop` returns 200. (In development, React's Strict Mode may send it twice. That is harmless, the route can be called again.) Then tap "I tapped Yes by mistake", answer "No, we're safe", fill in step 4 and continue. Check in the database that the draft's `safety_stopped_at` is null again.

- [ ] **Step 6: Commit**

```bash
git add src/features/booking/api.ts src/features/booking/problem-step.tsx
git commit -m "feat: the gas safety screen keeps the draft from being texted"
```

---

### Task 7: Docs and full check

**Files (repo `relay-api`):**
- Modify: `docs/real-texting-todo.md`
- Modify: `docs/superpowers/specs/2026-10-06-mvp-remaining-work.md`
- Modify: `docs/superpowers/specs/2026-10-10-lead-recovery-design.md` (status)

- [ ] **Step 1: `docs/real-texting-todo.md`**

Replace the item that begins `- [ ] Decide what happens after the gas / carbon monoxide safety stop.` (all its lines) with:

```md
- [x] After the gas / carbon monoxide safety stop the draft is marked (`safety_stopped_at`, set
      by `POST /online-booking/drafts/:token/safety-stop` from the safety screen) and never gets
      the recovery text. Finishing step 4 after "I tapped Yes by mistake" clears it.
```

Replace `- [ ] Recovery wait (60 minutes) and cutoff (24 hours) as contractor settings, not constants.` with:

```md
- [ ] Recovery timing as contractor settings, not constants. Today the texts go the first
      morning after (when quiet hours end), at least 60 minutes after the lead went quiet
      (`online-booking/recovery.ts`).
```

- [ ] **Step 2: `docs/superpowers/specs/2026-10-06-mvp-remaining-work.md`**

Replace the module 5 row with:

```md
| 5 | Lead recovery | Built: abandoned-booking text and missed-caller reminder, the next morning with three open times; never after the gas safety stop | — |
```

Replace `5. **Missed-caller reminder**: one text the next morning to a missed caller who didn't book.` with:

```md
5. ~~**Missed-caller reminder**~~: built 2026-10-10 (`specs/2026-10-10-lead-recovery-design.md`).
   Only callers who already agreed to texts get it, until the lawyer answers question 2.
```

- [ ] **Step 3: Spec status**

In `docs/superpowers/specs/2026-10-10-lead-recovery-design.md`, change `Status: proposed.` to `Status: built.`

- [ ] **Step 4: Full check**

Run in `relay-api`: `npm test`, `npm run typecheck`, `npm run lint`
Expected: every test passes, no type or lint errors. Report the real counts, and any failure word for word.

- [ ] **Step 5: Commit**

```bash
git add docs/real-texting-todo.md docs/superpowers/specs/2026-10-06-mvp-remaining-work.md docs/superpowers/specs/2026-10-10-lead-recovery-design.md
git commit -m "docs: lead recovery built"
```

- [ ] **Step 6: Confirm no trailer slipped in**

Run in both repos: `git log main..HEAD --format=%B | grep -i "co-authored" || echo none`
Expected: `none` in both.
