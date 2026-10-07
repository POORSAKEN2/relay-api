# Booking Manage Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A homeowner who booked online gets a private link in their confirmation and can
change the time or cancel the visit from it, until the window starts.

**Architecture:** `bookVisit()` stores the sha256 of a random token in
`jobs.manage_link_hash` and puts `https://<contractor>/manage/<token>` in the confirmation text
and email. Three public routes in `online-booking.routes.ts` find the job by (host's tenant,
token hash): `GET` the visit, `POST reschedule` (reuses `reserveWindow` through
`reserveOpenWindow`), `POST cancel` (reuses dispatch's `changeStatus`, which learns a
homeowner actor). Both changes text the homeowner (and email them when they have an email) and
any assigned technician, and emit the events the dispatch board already listens to. The web
app gets a public `/manage/:token` page that reuses the booking wizard's look and time picker.

**Tech Stack:** relay-api: Node 22, Express 5, Drizzle + PostgreSQL, Zod 4, Vitest +
supertest. relay-web: React 19, React Router, TanStack Query, Zod, Vitest (plain functions
only), base-ui dialog, sonner toasts.

**Spec:** `relay-api/docs/superpowers/specs/2026-10-04-booking-manage-link-design.md`

## Global Constraints

- Branch `feat/booking-manage-link` in both repos: `relay-api` from
  `feat/booking-confirmation`, `relay-web` from `dev-jan`.
- Never commit `relay-api/.env.example` (the user's own edit is in the working tree) or
  `relay-web/src/features/auth/landing.test.ts` (the user's untracked file). Always `git add`
  named files.
- Lean, plain code a junior developer can debug without AI. Short "why" comments, matching the
  files around them.
- Commit messages lowercase conventional, ending with the
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` line.
- Biome only on touched files: `npx biome check --write <paths>`.
- relay-api tests need the local test database. The 4 failing tests in
  `src/modules/branding/branding.test.ts` fail before this work (the test database's migration
  state); any other failure is ours.
- Text bodies plain characters only (`plainText`, `textWindow`); screens and API messages keep
  the app's `’` and `–`.
- Exact copy:
  - Link gone (404 `not_found`): `This link doesn’t work anymore. Call <phone> to make changes.`
  - Locked (409 `cannot_change`): `Your visit can’t be changed online anymore. Call <phone>.`
  - Confirmation text tail: `Pay at the visit. Change or cancel: <url> Reply STOP to opt out.`
  - Moved text: `<tenant>: your visit is moved to <day>, <window>. Change or cancel: <url>`
  - Cancelled text: `<tenant>: your visit on <day> is cancelled. Book again: <booking page>`
  - Technician cancel text: `<contractor>: Job cancelled. <service> in <city>, <day>, <window>.`
- `<phone>` is the tenant's `contactPhone` through `formatPhone()`.

## Review Focus

1. The same link opened after the visit was cancelled (by the homeowner or the office) → a
   clear "doesn't work anymore" answer, never someone else's visit or a crash. Test in Task 2.
2. Two taps on "Confirm new time" or a reschedule racing the office's move → the job ends in
   one window, the cap still holds, one set of texts. The lock in `lockJob` covers it; test the
   same-slot repeat in Task 2.
3. A homeowner with no phone on their customer record (office edited it) → the change still
   works, no text row. Test in Task 2.
4. Rescheduling into the window the visit is already in, or into a full window → nothing saved,
   nothing texted. Test in Task 2.
5. A token for another contractor's visit used on this contractor's address → 404. Test in
   Task 2.

## Files

| Repo | File | Change |
| --- | --- | --- |
| api | `src/lib/link-token.ts`, `link-token.test.ts` | New: `newLinkToken()`, `hashLinkToken()` |
| api | `src/modules/online-booking/confirmation.ts`, `confirmation.test.ts` | `manageUrl` in the confirmation; `addressLine`, `VisitChange`, `changedText/Email`, `cancelledText/Email` |
| api | `src/modules/online-booking/online-booking.service.ts`, `online-booking.test.ts` | `bookVisit` saves the hash and sends the link; `reserveOpenWindow` exported with `excludeJobId` |
| api | `src/modules/dispatch/technician-texts.ts` | New: `textTechnician` moved here, plus `'cancelled'` |
| api | `src/modules/dispatch/dispatch.service.ts` | `changeStatus` takes `actor`; uses `technician-texts.ts` |
| api | `src/modules/dispatch/dispatch.queries.ts` | `lockJob` also returns `windowStartsAt` |
| api | `src/modules/technician-jobs/technician-jobs.service.ts` | Passes `actor` |
| api | `src/modules/online-booking/manage.queries.ts`, `manage.service.ts`, `manage.test.ts` | New: the manage link's lookup, get, reschedule, cancel |
| api | `src/modules/online-booking/online-booking.schemas.ts`, `online-booking.routes.ts` | `RescheduleInput`; the three routes |
| web | `src/features/booking/booking-shell.tsx` | Optional `title` and `intro` |
| web | `src/features/booking/window-picker.tsx`, `time-step.tsx`, `api.ts` | `WindowPicker` pulled out of `TimeStep`; `OpenDay` type |
| web | `src/features/manage-booking/api.ts`, `view.ts`, `view.test.ts`, `manage-booking.tsx` | New: the manage page |
| web | `src/routes/manage.tsx`, `src/router.tsx` | New public route `/manage/:token` |

---

### Task 1: The link and the words

**Files:**
- Create: `relay-api/src/lib/link-token.ts`, `relay-api/src/lib/link-token.test.ts`
- Modify: `relay-api/src/modules/online-booking/confirmation.ts`, `confirmation.test.ts`
- Modify: `relay-api/src/modules/online-booking/online-booking.service.ts`,
  `online-booking.test.ts`

**Interfaces:**
- Produces:
  - `newLinkToken(): { token: string; hash: string }`, `hashLinkToken(token: string): string`
  - `Confirmation` gains `manageUrl: string`
  - `addressLine(a: { street: string; unit: string | null; city: string; state: string; zip: string }): string`
  - `type VisitChange = { tenantName: string; contactPhone: string; customerName: string; dayLabel: string; windowLabel: string; address: string; link: string }`
  - `changedText(v: VisitChange): string`, `changedEmail(v: VisitChange): { subject: string; body: string }`
  - `cancelledText(v: VisitChange): string`, `cancelledEmail(v: VisitChange): { subject: string; body: string }`
  - `reserveOpenWindow(tx: Tx, tenantId: string, windowId: string, date: string, excludeJobId?: string)`
    exported from `online-booking.service.ts`, returns `{ windowStartsAt: Date; windowEndsAt: Date }`

All commands in this task run in `relay-api`.

- [ ] **Step 1: Write the failing link-token test**

Create `src/lib/link-token.test.ts`:

```ts
import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { hashLinkToken, newLinkToken } from './link-token.ts'

it('makes a short, URL-safe token that is different every time', () => {
  const first = newLinkToken()
  expect(first.token).toMatch(/^[A-Za-z0-9_-]{24}$/)
  expect(newLinkToken().token).not.toBe(first.token)
})

it('stores only the token’s sha256', () => {
  const { token, hash } = newLinkToken()
  expect(hash).toBe(createHash('sha256').update(token).digest('hex'))
  expect(hashLinkToken(token)).toBe(hash)
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/lib/link-token.test.ts`
Expected: FAIL, cannot find module `./link-token.ts`.

- [ ] **Step 3: Write `src/lib/link-token.ts`**

```ts
import { createHash, randomBytes } from 'node:crypto'

// Private links sent in texts, like a homeowner's link to change or cancel their visit. Only
// the hash is stored, as for sessions: someone who reads the database can't use the links.
// 18 random bytes is far beyond guessing and keeps the link short in a text.
export function newLinkToken() {
  const token = randomBytes(18).toString('base64url')
  return { token, hash: hashLinkToken(token) }
}

export function hashLinkToken(token: string) {
  return createHash('sha256').update(token).digest('hex')
}
```

- [ ] **Step 4: Run it**

Run: `npx vitest run src/lib/link-token.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the failing word tests**

In `src/modules/online-booking/confirmation.test.ts`:

Change the import to:

```ts
import {
  type Confirmation,
  cancelledEmail,
  cancelledText,
  changedEmail,
  changedText,
  confirmationEmail,
  confirmationText,
  type VisitChange,
} from './confirmation.ts'
```

Add `manageUrl: 'https://desert.garified.com/manage/abc'` as the last field of `booking`.

In `'writes the confirmation text'`, change the expected text to:

```ts
    "Desert Breeze Air: you're booked for AC Repair on Tue, Oct 6, 8 AM - 12 PM at 123 Main St. Pay at the visit. Change or cancel: https://desert.garified.com/manage/abc Reply STOP to opt out.",
```

In `'writes the confirmation email'`, change the body's lines after `'Address: 123 Main St, Phoenix, AZ 85001',` to:

```ts
      '',
      "There's nothing to pay now. You pay the technician at the visit.",
      '',
      'Need to change or cancel? https://desert.garified.com/manage/abc',
      '',
      'Questions? Call 0917 123 4567 or reply to this email.',
      '',
      'Desert Breeze Air',
```

Add at the end:

```ts
const change: VisitChange = {
  tenantName: 'Rico’s Air',
  contactPhone: '+639171234567',
  customerName: 'Maria Lopez',
  dayLabel: 'Wed, Oct 7',
  windowLabel: '12 PM - 4 PM',
  address: '123 Main St, Phoenix, AZ 85001',
  link: 'https://rico.garified.com/manage/abc',
}

it('writes the moved text and email', () => {
  expect(changedText(change)).toBe(
    "Rico's Air: your visit is moved to Wed, Oct 7, 12 PM - 4 PM. Change or cancel: https://rico.garified.com/manage/abc",
  )
  expect(changedEmail(change)).toEqual({
    subject: 'Your visit is moved to Wed, Oct 7',
    body: [
      'Hi Maria,',
      '',
      'Your visit with Rico’s Air is moved.',
      '',
      'Arrival window: Wed, Oct 7, 12 PM - 4 PM',
      'Address: 123 Main St, Phoenix, AZ 85001',
      '',
      'Need to change or cancel again? https://rico.garified.com/manage/abc',
      '',
      'Questions? Call 0917 123 4567 or reply to this email.',
      '',
      'Rico’s Air',
    ].join('\n'),
  })
})

it('writes the cancelled text and email', () => {
  const cancelled = { ...change, link: 'https://rico.garified.com/' }
  expect(cancelledText(cancelled)).toBe(
    "Rico's Air: your visit on Wed, Oct 7 is cancelled. Book again: https://rico.garified.com/",
  )
  expect(cancelledEmail(cancelled)).toEqual({
    subject: 'Your visit on Wed, Oct 7 is cancelled',
    body: [
      'Hi Maria,',
      '',
      'Your visit with Rico’s Air on Wed, Oct 7, 12 PM - 4 PM is cancelled.',
      '',
      'To book another visit: https://rico.garified.com/',
      '',
      'Questions? Call 0917 123 4567 or reply to this email.',
      '',
      'Rico’s Air',
    ].join('\n'),
  })
})
```

- [ ] **Step 6: Run them to see them fail**

Run: `npx vitest run src/modules/online-booking/confirmation.test.ts`
Expected: FAIL. `changedText` etc. are not exported, and the confirmation text has no link.

- [ ] **Step 7: Update `src/modules/online-booking/confirmation.ts`**

Change the header comment's first line to `// What the homeowner is told by text and email about their visit: the confirmation right
// after booking online, and the news when they move or cancel it from their link.` (keep the
"Pure, so…" sentence).

Add `manageUrl: string // the link to change or cancel the visit` as the last field of
`Confirmation`.

Replace `confirmationText` and `confirmationEmail` with:

```ts
export function confirmationText(v: Confirmation): string {
  const street = v.unit ? `${v.street}, ${v.unit}` : v.street
  return plainText(
    `${v.tenantName}: you're booked for ${v.serviceName} on ${v.dayLabel}, ${v.windowLabel} at ${street}. Pay at the visit. Change or cancel: ${v.manageUrl} Reply STOP to opt out.`,
  )
}

export function confirmationEmail(v: Confirmation): { subject: string; body: string } {
  const priority =
    v.priorityFeeCents > 0
      ? [`Priority service: ${formatMoney(v.priorityFeeCents, v.currency)}, paid at the visit`]
      : []
  const body = [
    `Hi ${firstName(v.customerName)},`,
    '',
    `Your visit with ${v.tenantName} is booked.`,
    '',
    `Service: ${v.serviceName}`,
    `Arrival window: ${v.dayLabel}, ${v.windowLabel}`,
    `Address: ${addressLine(v)}`,
    ...priority,
    '',
    "There's nothing to pay now. You pay the technician at the visit.",
    '',
    `Need to change or cancel? ${v.manageUrl}`,
    ...signOff(v),
  ]
  return { subject: `Your visit is booked: ${v.dayLabel}`, body: body.join('\n') }
}

// '123 Main St, Unit 4, Phoenix, AZ 85001'; the unit is left out when there is none.
export function addressLine(a: {
  street: string
  unit: string | null
  city: string
  state: string
  zip: string
}): string {
  return [a.street, a.unit, a.city, `${a.state} ${a.zip}`].filter(Boolean).join(', ')
}

// What the homeowner is told after moving or cancelling from their link. `link` is the same
// manage link (moved) or the booking page (cancelled).
export type VisitChange = {
  tenantName: string
  contactPhone: string // the contractor's, E.164
  customerName: string
  dayLabel: string // 'Wed, Oct 7'
  windowLabel: string // '12 PM - 4 PM' (textWindow)
  address: string // addressLine()
  link: string
}

export function changedText(v: VisitChange): string {
  return plainText(
    `${v.tenantName}: your visit is moved to ${v.dayLabel}, ${v.windowLabel}. Change or cancel: ${v.link}`,
  )
}

export function changedEmail(v: VisitChange): { subject: string; body: string } {
  const body = [
    `Hi ${firstName(v.customerName)},`,
    '',
    `Your visit with ${v.tenantName} is moved.`,
    '',
    `Arrival window: ${v.dayLabel}, ${v.windowLabel}`,
    `Address: ${v.address}`,
    '',
    `Need to change or cancel again? ${v.link}`,
    ...signOff(v),
  ]
  return { subject: `Your visit is moved to ${v.dayLabel}`, body: body.join('\n') }
}

export function cancelledText(v: VisitChange): string {
  return plainText(`${v.tenantName}: your visit on ${v.dayLabel} is cancelled. Book again: ${v.link}`)
}

export function cancelledEmail(v: VisitChange): { subject: string; body: string } {
  const body = [
    `Hi ${firstName(v.customerName)},`,
    '',
    `Your visit with ${v.tenantName} on ${v.dayLabel}, ${v.windowLabel} is cancelled.`,
    '',
    `To book another visit: ${v.link}`,
    ...signOff(v),
  ]
  return { subject: `Your visit on ${v.dayLabel} is cancelled`, body: body.join('\n') }
}

function firstName(name: string) {
  return name.split(' ')[0]
}

// The end of every email: how to reach the contractor, and their name.
function signOff(v: { tenantName: string; contactPhone: string }) {
  return [
    '',
    `Questions? Call ${formatPhone(v.contactPhone)} or reply to this email.`,
    '',
    v.tenantName,
  ]
}
```

- [ ] **Step 8: Run the word tests**

Run: `npx vitest run src/modules/online-booking/confirmation.test.ts src/lib/link-token.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 9: Write the failing booking test**

In `src/modules/online-booking/online-booking.test.ts`, add
`import { hashLinkToken } from '../../lib/link-token.ts'` to the imports.

In `'texts and emails the homeowner a confirmation'`, replace the sms row's `body: "desert
HVAC: …"` line with:

```ts
        body: expect.stringMatching(
          /^desert HVAC: you're booked for AC repair on Tue, Jan 8, 8 AM - 12 PM at 4 Cactus Rd\. Pay at the visit\. Change or cancel: https:\/\/desert\.localhost\/manage\/[\w-]{24} Reply STOP to opt out\.$/,
        ),
```

Add after that test:

```ts
  it('gives the visit a private link to change or cancel it', async () => {
    const shop = await createServingShop()

    const res = await post('bookings', bookingBody(shop)).expect(201)

    const [job] = await db.select().from(jobs).where(eq(jobs.id, res.body.jobId))
    const sent = await db.select().from(messages).orderBy(asc(messages.channel))
    const url = /https:\/\/desert\.localhost\/manage\/([\w-]{24})/.exec(sent[1].body)
    expect(url).not.toBeNull()
    // Only the hash is stored.
    expect(job.manageLinkHash).toBe(hashLinkToken(url![1]))
    expect(sent[0].body).toContain(`Need to change or cancel? ${url![0]}`)
  })
```

- [ ] **Step 10: Run it to see it fail**

Run: `npx vitest run src/modules/online-booking/online-booking.test.ts`
Expected: FAIL. The text has no link (and `manageLinkHash` is null). Also a type error is
fine to see later in typecheck: `bookVisit` doesn't pass `manageUrl` yet.

- [ ] **Step 11: Save the hash and send the link in `bookVisit()`**

In `src/modules/online-booking/online-booking.service.ts`:

Add the import `import { newLinkToken } from '../../lib/link-token.ts'`.

At the top of `bookVisit()`, after `const priorityFeeCents = …`:

```ts
  // The homeowner's private link to change or cancel; only its hash is stored.
  const manageLink = newLinkToken()
```

In the `insertBookedJob(...)` values, after `vulnerableOccupant: input.vulnerableOccupant,`
add:

```ts
        manageLinkHash: manageLink.hash,
```

In the `confirmation` object, after `priorityFeeCents,` add:

```ts
      manageUrl: tenantUrl(tenant, `/manage/${manageLink.token}`),
```

Export `reserveOpenWindow` with an `excludeJobId` option. Replace its signature and the
`reserveWindow` call:

```ts
// Takes a place in the window like the office does, but never over the cap, never in a window
// that already started, and without telling a homeowner how many jobs are booked.
// `excludeJobId`: a visit being moved doesn't count against its own new window.
export async function reserveOpenWindow(
  tx: Tx,
  tenantId: string,
  windowId: string,
  date: string,
  excludeJobId?: string,
) {
  let slot: Awaited<ReturnType<typeof reserveWindow>>
  try {
    slot = await reserveWindow(tx, tenantId, windowId, date, { allowOverCap: false, excludeJobId })
```

(the rest of the function stays the same).

- [ ] **Step 12: Run the tests and typecheck**

Run: `npx vitest run src/modules/online-booking src/lib`
Expected: PASS.
Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 13: Lint and commit**

Run: `npx biome check --write src/lib/link-token.ts src/lib/link-token.test.ts src/modules/online-booking/confirmation.ts src/modules/online-booking/confirmation.test.ts src/modules/online-booking/online-booking.service.ts src/modules/online-booking/online-booking.test.ts`

```bash
git add src/lib/link-token.ts src/lib/link-token.test.ts src/modules/online-booking/confirmation.ts src/modules/online-booking/confirmation.test.ts src/modules/online-booking/online-booking.service.ts src/modules/online-booking/online-booking.test.ts
git commit -m "feat: a private link to change or cancel in the booking confirmation" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The manage API

**Files:**
- Create: `relay-api/src/modules/dispatch/technician-texts.ts`
- Modify: `relay-api/src/modules/dispatch/dispatch.service.ts`,
  `relay-api/src/modules/dispatch/dispatch.queries.ts`,
  `relay-api/src/modules/technician-jobs/technician-jobs.service.ts`
- Create: `relay-api/src/modules/online-booking/manage.queries.ts`, `manage.service.ts`,
  `manage.test.ts`
- Modify: `relay-api/src/modules/online-booking/online-booking.schemas.ts`,
  `online-booking.routes.ts`

**Interfaces:**
- Consumes (Task 1): `hashLinkToken`, `addressLine`, `VisitChange`, `changedText`,
  `changedEmail`, `cancelledText`, `cancelledEmail`, `reserveOpenWindow(tx, tenantId,
  windowId, date, excludeJobId?)`. Existing: `sendText`, `sendEmail`, `tenantUrl`,
  `formatDay`, `formatWindow`, `textWindow`, `formatPhone`, `emitToTenant`,
  `audit.insertHomeownerAction`, `dispatch.lockJob`, `dispatch.updateJob`, `local`.
- Produces (Task 3 relies on the HTTP shape):
  - `GET /api/online-booking/manage/:token` → `{ status, serviceName, date, dayLabel, windowLabel, address, canChange, contactPhone }`
  - `POST /api/online-booking/manage/:token/reschedule` body `{ date, windowId }` → same shape
  - `POST /api/online-booking/manage/:token/cancel` → `{ status: 'cancelled' }`
  - Errors `404 not_found`, `409 cannot_change`, `409 window_full`, `422 window_started`,
    `422 past_date`, `400 validation_failed`
  - `textTechnician(tenantId, jobId, technicianId, what: 'assigned' | 'changed' | 'cancelled', tx)`
  - `changeStatus({ tenantId, actor: { userId: string } | 'homeowner', jobId, to, etaAt?, checkJob?, afterChange? })`

All commands in this task run in `relay-api`.

- [ ] **Step 1: Write the failing manage tests**

Create `src/modules/online-booking/manage.test.ts`:

```ts
import { eq } from 'drizzle-orm'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createJob, createShop, resetDb, type Shop, TUESDAY } from '../../../test/helpers.ts'
import { createApp } from '../../app.ts'
import { db } from '../../db/client.ts'
import { auditEvents, consentEvents, customers, jobs, messages } from '../../db/schema.ts'
import { hashLinkToken } from '../../lib/link-token.ts'
import { emitToTenant } from '../../realtime/index.ts'

vi.mock('../../realtime/index.ts', () => ({ emitToTenant: vi.fn() }))

const app = createApp()
const TOKEN = 'test-manage-token-0000001'
const WEDNESDAY = '2030-01-09'

beforeEach(async () => {
  await resetDb()
  vi.mocked(emitToTenant).mockClear()
})

// The manage page has no sign-in: the token finds the visit, the address the contractor.
function get(token = TOKEN, slug = 'desert') {
  return request(app)
    .get(`/api/online-booking/manage/${token}`)
    .set('X-Tenant-Host', `${slug}.localhost`)
}

function post(path: string, body: object = {}) {
  return request(app)
    .post(`/api/online-booking/manage/${TOKEN}/${path}`)
    .set('X-Tenant-Host', 'desert.localhost')
    .send(body)
}

// Maria's visit on Tuesday 8 AM–12 PM, with a link. She agreed to texts and gave an email,
// unless `consent` is false.
async function visitWithLink(
  shop: Shop,
  values: Parameters<typeof createJob>[1] = {},
  { consent = true } = {},
) {
  await db
    .update(customers)
    .set({ email: 'maria@example.com' })
    .where(eq(customers.id, shop.customer.id))
  if (consent) {
    await db.insert(consentEvents).values({
      tenantId: shop.tenant.id,
      contact: '+16025550111',
      channel: 'sms',
      granted: true,
      source: 'booking_form',
    })
  }
  return createJob(shop, { source: 'web', manageLinkHash: hashLinkToken(TOKEN), ...values })
}

async function reload(jobId: string) {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId))
  return job
}

const sentSummary = async () =>
  (await db.select().from(messages)).map((m) => [m.channel, m.kind, m.contact]).sort()

describe('GET /api/online-booking/manage/:token', () => {
  it('shows the visit, and that it can still be changed', async () => {
    const shop = await createShop('desert')
    await visitWithLink(shop)

    expect((await get().expect(200)).body).toEqual({
      status: 'booked',
      serviceName: 'AC repair',
      date: TUESDAY,
      dayLabel: 'Tue, Jan 8',
      windowLabel: '8 AM–12 PM',
      address: '12 Palm St, Phoenix, AZ 85004',
      canChange: true,
      contactPhone: '(480) 555-0100',
    })
  })

  it('can’t be changed once the technician is on the way', async () => {
    const shop = await createShop('desert')
    await visitWithLink(shop, { status: 'en_route', technicianId: shop.mike.id })

    expect((await get().expect(200)).body).toMatchObject({ status: 'en_route', canChange: false })
  })

  it('can’t be changed once the window started', async () => {
    const shop = await createShop('desert')
    await visitWithLink(shop, { at: '2020-01-07 08:00' })

    expect((await get().expect(200)).body.canChange).toBe(false)
  })

  it('doesn’t work with a wrong token or on another contractor’s address', async () => {
    const shop = await createShop('desert')
    await createShop('other')
    await visitWithLink(shop)

    const wrong = await get('not-the-token').expect(404)
    expect(wrong.body.error).toEqual({
      code: 'not_found',
      message: 'This link doesn’t work anymore. Call (480) 555-0100 to make changes.',
    })
    await get(TOKEN, 'other').expect(404)
  })
})

describe('POST /api/online-booking/manage/:token/reschedule', () => {
  it('moves the visit, tells everyone and keeps the technician', async () => {
    const shop = await createShop('desert')
    const job = await visitWithLink(shop, {
      technicianId: shop.mike.id,
      etaAt: new Date('2030-01-08T16:00:00Z'),
    })

    const res = await post('reschedule', { date: WEDNESDAY, windowId: shop.wedMorning.id }).expect(
      200,
    )

    expect(res.body).toMatchObject({ date: WEDNESDAY, dayLabel: 'Wed, Jan 9', canChange: true })
    expect(await reload(job.id)).toMatchObject({
      windowStartsAt: new Date('2030-01-09T15:00:00Z'),
      technicianId: shop.mike.id,
      etaAt: null,
      status: 'booked',
    })
    const [audit] = await db.select().from(auditEvents)
    expect(audit).toMatchObject({ actorType: 'homeowner', action: 'job.moved', entityId: job.id })
    expect(emitToTenant).toHaveBeenCalledWith(shop.tenant.id, 'job.assigned', {
      jobId: job.id,
      dates: [TUESDAY, WEDNESDAY],
    })

    expect(await sentSummary()).toEqual([
      ['email', 'booking_changed', 'maria@example.com'],
      ['sms', 'booking_changed', '+16025550111'],
      ['sms', 'job_assigned', shop.mike.phone],
    ])
    const sent = await db.select().from(messages)
    const homeowner = sent.find((m) => m.channel === 'sms' && m.kind === 'booking_changed')!
    expect(homeowner.body).toBe(
      `desert HVAC: your visit is moved to Wed, Jan 9, 8 AM - 12 PM. Change or cancel: https://desert.localhost/manage/${TOKEN}`,
    )
    expect(sent.find((m) => m.kind === 'job_assigned')!.body).toContain('Job changed')
    expect(sent.find((m) => m.channel === 'email')!.subject).toBe('Your visit is moved to Wed, Jan 9')
  })

  it('does nothing when the time is the same, as after a double tap', async () => {
    const shop = await createShop('desert')
    await visitWithLink(shop)

    await post('reschedule', { date: TUESDAY, windowId: shop.tueMorning.id }).expect(200)

    expect(await db.select().from(auditEvents)).toHaveLength(0)
    expect(await db.select().from(messages)).toHaveLength(0)
    expect(emitToTenant).not.toHaveBeenCalled()
  })

  it('refuses a full window and changes nothing', async () => {
    const shop = await createShop('desert')
    const job = await visitWithLink(shop)
    await createJob(shop, { at: `${WEDNESDAY} 08:00` })
    await createJob(shop, { at: `${WEDNESDAY} 08:00` })

    const res = await post('reschedule', { date: WEDNESDAY, windowId: shop.wedMorning.id }).expect(
      409,
    )

    expect(res.body.error.code).toBe('window_full')
    expect((await reload(job.id)).windowStartsAt).toEqual(new Date('2030-01-08T15:00:00Z'))
    expect(await db.select().from(messages)).toHaveLength(0)
  })

  it('refuses once the technician is on the way', async () => {
    const shop = await createShop('desert')
    await visitWithLink(shop, { status: 'en_route', technicianId: shop.mike.id })

    const res = await post('reschedule', { date: WEDNESDAY, windowId: shop.wedMorning.id }).expect(
      409,
    )

    expect(res.body.error).toEqual({
      code: 'cannot_change',
      message: 'Your visit can’t be changed online anymore. Call (480) 555-0100.',
    })
    expect(await db.select().from(messages)).toHaveLength(0)
  })

  it('still moves the visit of a homeowner with no phone on file, texting nobody', async () => {
    const shop = await createShop('desert')
    const job = await visitWithLink(shop, {}, { consent: false })
    await db.update(customers).set({ phone: null }).where(eq(customers.id, shop.customer.id))

    await post('reschedule', { date: WEDNESDAY, windowId: shop.wedMorning.id }).expect(200)

    expect((await reload(job.id)).windowStartsAt).toEqual(new Date('2030-01-09T15:00:00Z'))
    expect(await sentSummary()).toEqual([['email', 'booking_changed', 'maria@example.com']])
  })

  it('refuses a body without a window', async () => {
    const shop = await createShop('desert')
    await visitWithLink(shop)

    const res = await post('reschedule', { date: WEDNESDAY, windowId: 'nope' }).expect(400)
    expect(res.body.error.details).toEqual({ windowId: ['Pick an arrival window'] })
  })
})

describe('POST /api/online-booking/manage/:token/cancel', () => {
  it('cancels the visit, tells everyone, and the link stops working', async () => {
    const shop = await createShop('desert')
    const job = await visitWithLink(shop, { technicianId: shop.mike.id })

    expect((await post('cancel').expect(200)).body).toEqual({ status: 'cancelled' })

    expect(await reload(job.id)).toMatchObject({ status: 'cancelled', manageLinkHash: null })
    const [audit] = await db.select().from(auditEvents)
    expect(audit).toMatchObject({
      actorType: 'homeowner',
      actorUserId: null,
      action: 'job.status_changed',
      data: { from: 'booked', to: 'cancelled' },
    })
    expect(emitToTenant).toHaveBeenCalledWith(shop.tenant.id, 'job.status_changed', {
      jobId: job.id,
      dates: [TUESDAY],
    })

    expect(await sentSummary()).toEqual([
      ['email', 'booking_changed', 'maria@example.com'],
      ['sms', 'booking_changed', '+16025550111'],
      ['sms', 'job_assigned', shop.mike.phone],
    ])
    const sent = await db.select().from(messages)
    expect(sent.find((m) => m.channel === 'sms' && m.kind === 'booking_changed')!.body).toBe(
      'desert HVAC: your visit on Tue, Jan 8 is cancelled. Book again: https://desert.localhost/',
    )
    expect(sent.find((m) => m.kind === 'job_assigned')!.body).toBe(
      'desert HVAC: Job cancelled. AC repair in Phoenix, Tue, Jan 8, 8 AM-12 PM.',
    )

    await get().expect(404)
  })

  it('keeps the text from a homeowner who didn’t agree to texts', async () => {
    const shop = await createShop('desert')
    await visitWithLink(shop, {}, { consent: false })

    await post('cancel').expect(200)

    const [text] = await db.select().from(messages).where(eq(messages.channel, 'sms'))
    expect(text).toMatchObject({ status: 'blocked', blockedReason: 'no_consent' })
  })

  it('refuses once the window started', async () => {
    const shop = await createShop('desert')
    const job = await visitWithLink(shop, { at: '2020-01-07 08:00' })

    const res = await post('cancel').expect(409)

    expect(res.body.error.code).toBe('cannot_change')
    expect((await reload(job.id)).status).toBe('booked')
    expect(await db.select().from(messages)).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/modules/online-booking/manage.test.ts`
Expected: FAIL, every route answers 404 `Not found` (no such route yet).

- [ ] **Step 3: Move the technician text to its own file, with "cancelled"**

Create `src/modules/dispatch/technician-texts.ts`:

```ts
import type { Tx } from '../../db/client.ts'
import { formatDay, formatWindow } from '../../lib/labels.ts'
import { tenantUrl } from '../../lib/tenant-url.ts'
import { sendText } from '../messaging/sms.ts'
import * as queries from './dispatch.queries.ts'

// Saves a text to the technician about one of their jobs, in the caller's transaction: new,
// changed (with a link to the job page; the page needs them signed in, and the sign-in page
// sends them on to the job afterwards), or cancelled (no link: the job is gone from their
// list). Used by the office's moves and the homeowner's manage link. A technician without a
// phone gets none; the change stands.
export async function textTechnician(
  tenantId: string,
  jobId: string,
  technicianId: string,
  what: 'assigned' | 'changed' | 'cancelled',
  tx: Tx,
) {
  const job = await queries.findAssignmentText(tenantId, jobId, technicianId, tx)
  if (!job?.technicianPhone) return
  // A plain hyphen: an en dash would make the SMS cost 70 characters instead of 160.
  const when = `${formatDay(job.date)}, ${formatWindow(job.localStart, job.localEnd).replace('–', '-')}`
  const about = `${job.serviceName} in ${job.city}, ${when}.`
  const body =
    what === 'cancelled'
      ? `${job.contractorName}: Job cancelled. ${about}`
      : `${job.contractorName}: ${what === 'assigned' ? 'New job' : 'Job changed'}. ${about} ${tenantUrl(job.tenant, `/jobs/${jobId}`)}`
  await sendText(
    tenantId,
    { contact: job.technicianPhone, kind: 'job_assigned', body, toUserId: technicianId, jobId },
    tx,
  )
}
```

In `src/modules/dispatch/dispatch.service.ts`:
- Delete the whole `textTechnician` function and the comment above it.
- Add `import { textTechnician } from './technician-texts.ts'`.
- Remove imports left unused: `tenantUrl`, `sendText`, and `formatWindow` if nothing else in
  the file uses them (check with `rg "formatWindow|tenantUrl|sendText" src/modules/dispatch/dispatch.service.ts`).

- [ ] **Step 4: Let `changeStatus` take a homeowner as the actor**

In `src/modules/dispatch/dispatch.queries.ts`, `lockJob`'s select gains
`windowStartsAt: jobs.windowStartsAt,` after `technicianId: jobs.technicianId,`.

In `src/modules/dispatch/dispatch.service.ts`, in `changeStatus`'s parameter type replace
`actorUserId: string` with:

```ts
  // Who changed it: a signed-in user, or the homeowner from their manage link.
  actor: { userId: string } | 'homeowner'
```

Replace the `audit.insertUserAction(...)` call inside `changeStatus` with:

```ts
    const event = {
      action: 'job.status_changed',
      entityType: 'job',
      entityId: job.id,
      data: { from: job.status, to },
    }
    if (change.actor === 'homeowner') await audit.insertHomeownerAction(tenantId, event, tx)
    else await audit.insertUserAction(tenantId, { ...event, actorUserId: change.actor.userId }, tx)
```

In `setStatus` (same file) and in `changeMyJob` in
`src/modules/technician-jobs/technician-jobs.service.ts`, replace `actorUserId: user.id,` with
`actor: { userId: user.id },`.

Run: `npm run typecheck`
Expected: no errors.
Run: `npx vitest run src/modules/dispatch src/modules/technician-jobs`
Expected: PASS (the office and technician tests are unchanged and still green).

- [ ] **Step 5: The lookup, the schema and the service**

Create `src/modules/online-booking/manage.queries.ts`:

```ts
import { and, eq } from 'drizzle-orm'
import { type Db, db } from '../../db/client.ts'
import { customers, jobs, properties, services, tenants } from '../../db/schema.ts'
import { local } from '../dispatch/dispatch.queries.ts'

// Tenant-scoped, like every query: a link only works on its own contractor's address.

// The visit behind a manage link, with what the page and the texts need. Closed jobs have no
// link hash, so they are never found.
export async function findManagedJob(tenantId: string, linkHash: string, tx: Db = db) {
  const [job] = await tx
    .select({
      id: jobs.id,
      status: jobs.status,
      windowStartsAt: jobs.windowStartsAt,
      windowEndsAt: jobs.windowEndsAt,
      date: local(jobs.windowStartsAt, 'YYYY-MM-DD'),
      localStart: local(jobs.windowStartsAt, 'HH24:MI:SS'),
      localEnd: local(jobs.windowEndsAt, 'HH24:MI:SS'),
      serviceName: services.name,
      street: properties.street,
      unit: properties.unit,
      city: properties.city,
      state: properties.state,
      zip: properties.zip,
      customerId: customers.id,
      customerName: customers.name,
      customerPhone: customers.phone,
      customerEmail: customers.email,
    })
    .from(jobs)
    .innerJoin(tenants, eq(tenants.id, jobs.tenantId))
    .innerJoin(services, eq(services.id, jobs.serviceId))
    .innerJoin(properties, eq(properties.id, jobs.propertyId))
    .innerJoin(customers, eq(customers.id, jobs.customerId))
    .where(and(eq(jobs.tenantId, tenantId), eq(jobs.manageLinkHash, linkHash)))
  return job
}
```

In `src/modules/online-booking/online-booking.schemas.ts`, at the end:

```ts
// The manage page: a new arrival window for a booked visit.
export const RescheduleInput = z.object({
  date: LocalDate,
  windowId: z.uuid('Pick an arrival window'),
})
export type RescheduleInput = z.infer<typeof RescheduleInput>
```

Create `src/modules/online-booking/manage.service.ts`:

```ts
import { type Db, db } from '../../db/client.ts'
import type { Tenant } from '../../db/schema.ts'
import { HttpError } from '../../lib/http-error.ts'
import { formatDay, formatPhone, formatWindow, textWindow } from '../../lib/labels.ts'
import { hashLinkToken } from '../../lib/link-token.ts'
import { tenantUrl } from '../../lib/tenant-url.ts'
import { emitToTenant } from '../../realtime/index.ts'
import * as audit from '../audit/audit.queries.ts'
import * as dispatch from '../dispatch/dispatch.queries.ts'
import { changeStatus } from '../dispatch/dispatch.service.ts'
import { textTechnician } from '../dispatch/technician-texts.ts'
import { sendEmail } from '../messaging/email.ts'
import { sendText } from '../messaging/sms.ts'
import {
  addressLine,
  cancelledEmail,
  cancelledText,
  changedEmail,
  changedText,
  type VisitChange,
} from './confirmation.ts'
import * as queries from './manage.queries.ts'
import type { RescheduleInput } from './online-booking.schemas.ts'
import { reserveOpenWindow } from './online-booking.service.ts'

// The homeowner's link to change or cancel their visit (sent in the booking confirmation).
// Nobody is signed in: the token finds the visit, and only on its own contractor's address.

type ManagedJob = NonNullable<Awaited<ReturnType<typeof queries.findManagedJob>>>

const linkGone = (tenant: Tenant) =>
  new HttpError(
    404,
    'not_found',
    `This link doesn’t work anymore. Call ${formatPhone(tenant.contactPhone)} to make changes.`,
  )

const cannotChange = (tenant: Tenant) =>
  new HttpError(
    409,
    'cannot_change',
    `Your visit can’t be changed online anymore. Call ${formatPhone(tenant.contactPhone)}.`,
  )

// Online, a visit can change only while it is booked and its window hasn't started. After
// that the technician may be on the way, so the homeowner calls the office.
function changeable(job: { status: string; windowStartsAt: Date }) {
  return job.status === 'booked' && job.windowStartsAt > new Date()
}

async function findJob(tenant: Tenant, token: string, tx: Db = db) {
  const job = await queries.findManagedJob(tenant.id, hashLinkToken(token), tx)
  if (!job) throw linkGone(tenant)
  return job
}

export async function getVisit(tenant: Tenant, token: string) {
  const job = await findJob(tenant, token)
  return {
    status: job.status,
    serviceName: job.serviceName,
    date: job.date,
    dayLabel: formatDay(job.date),
    windowLabel: formatWindow(job.localStart, job.localEnd),
    address: addressLine(job),
    canChange: changeable(job),
    contactPhone: formatPhone(tenant.contactPhone),
  }
}

// Moves the visit to another open window. The technician stays assigned; they are told.
export async function rescheduleVisit(tenant: Tenant, token: string, input: RescheduleInput) {
  const result = await db.transaction(async (tx) => {
    const found = await findJob(tenant, token, tx)
    // Locked, so a double tap or the office moving it at the same time waits its turn.
    const job = await dispatch.lockJob(tenant.id, found.id, tx)
    if (!job || !changeable(job)) throw cannotChange(tenant)
    if (input.date === job.date && input.windowId === job.windowId) return null

    const slot = await reserveOpenWindow(tx, tenant.id, input.windowId, input.date, job.id)
    // A new time makes the old arrival time meaningless.
    await dispatch.updateJob(tenant.id, job.id, { ...slot, etaAt: null }, tx)
    await audit.insertHomeownerAction(
      tenant.id,
      {
        action: 'job.moved',
        entityType: 'job',
        entityId: job.id,
        data: {
          from: { date: job.date, windowId: job.windowId },
          to: { date: input.date, windowId: input.windowId },
        },
      },
      tx,
    )

    const change = visitChange(tenant, found, {
      dayLabel: formatDay(input.date),
      windowLabel: textWindow(slot.windowStartsAt, slot.windowEndsAt, tenant.timezone),
      link: tenantUrl(tenant, `/manage/${token}`),
    })
    await tellHomeowner(tenant.id, found, changedText(change), changedEmail(change), tx)
    if (job.technicianId) await textTechnician(tenant.id, job.id, job.technicianId, 'changed', tx)
    return { jobId: job.id, dates: [...new Set([job.date, input.date])] }
  })

  // The board reloads on the same event as an office move.
  if (result) emitToTenant(tenant.id, 'job.assigned', result)
  return getVisit(tenant, token)
}

// Cancels through dispatch's changeStatus, like an office cancel: the status rules, the
// cleared links and the board event all come from there.
export async function cancelVisit(tenant: Tenant, token: string) {
  const job = await findJob(tenant, token)
  let technicianId: string | null = null
  await changeStatus({
    tenantId: tenant.id,
    actor: 'homeowner',
    jobId: job.id,
    to: 'cancelled',
    checkJob: (locked) => {
      if (!changeable(locked)) throw cannotChange(tenant)
      technicianId = locked.technicianId
    },
    afterChange: async (tx) => {
      const change = visitChange(tenant, job, {
        dayLabel: formatDay(job.date),
        windowLabel: textWindow(job.windowStartsAt, job.windowEndsAt, tenant.timezone),
        link: tenantUrl(tenant, '/'),
      })
      await tellHomeowner(tenant.id, job, cancelledText(change), cancelledEmail(change), tx)
      if (technicianId) await textTechnician(tenant.id, job.id, technicianId, 'cancelled', tx)
    },
  })
  return { status: 'cancelled' as const }
}

function visitChange(
  tenant: Tenant,
  job: ManagedJob,
  parts: Pick<VisitChange, 'dayLabel' | 'windowLabel' | 'link'>,
): VisitChange {
  return {
    tenantName: tenant.name,
    contactPhone: tenant.contactPhone,
    customerName: job.customerName,
    address: addressLine(job),
    ...parts,
  }
}

// A text when the customer has a phone (sendText applies consent), an email when they have one.
async function tellHomeowner(
  tenantId: string,
  job: ManagedJob,
  text: string,
  email: { subject: string; body: string },
  tx: Db,
) {
  const about = { kind: 'booking_changed' as const, jobId: job.id, customerId: job.customerId }
  if (job.customerPhone) {
    await sendText(tenantId, { ...about, contact: job.customerPhone, body: text }, tx)
  }
  if (job.customerEmail) {
    await sendEmail(tenantId, { ...about, contact: job.customerEmail, ...email }, tx)
  }
}
```

- [ ] **Step 6: The routes**

In `src/modules/online-booking/online-booking.routes.ts`, add `RescheduleInput` to the schema
import and `import * as manage from './manage.service.ts'`. At the end:

```ts
// The homeowner's link from their confirmation: see, move or cancel the visit.
onlineBookingRoutes.get(
  '/online-booking/manage/:token',
  formLimit,
  tenantFromHost,
  async (req, res) => {
    res.json(await manage.getVisit(req.tenant!, String(req.params.token)))
  },
)

onlineBookingRoutes.post(
  '/online-booking/manage/:token/reschedule',
  formLimit,
  tenantFromHost,
  async (req, res) => {
    const input = RescheduleInput.parse(req.body)
    res.json(await manage.rescheduleVisit(req.tenant!, String(req.params.token), input))
  },
)

onlineBookingRoutes.post(
  '/online-booking/manage/:token/cancel',
  formLimit,
  tenantFromHost,
  async (req, res) => {
    res.json(await manage.cancelVisit(req.tenant!, String(req.params.token)))
  },
)
```

- [ ] **Step 7: Run the manage tests**

Run: `npx vitest run src/modules/online-booking/manage.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 8: Run everything**

Run: `npm run typecheck && npm test`
Expected: no type errors; every test passes except the 4 known `branding.test.ts` failures.

- [ ] **Step 9: Lint and commit**

Run: `npx biome check --write src/modules/dispatch/technician-texts.ts src/modules/dispatch/dispatch.service.ts src/modules/dispatch/dispatch.queries.ts src/modules/technician-jobs/technician-jobs.service.ts src/modules/online-booking/manage.queries.ts src/modules/online-booking/manage.service.ts src/modules/online-booking/manage.test.ts src/modules/online-booking/online-booking.schemas.ts src/modules/online-booking/online-booking.routes.ts`

```bash
git add src/modules/dispatch/technician-texts.ts src/modules/dispatch/dispatch.service.ts src/modules/dispatch/dispatch.queries.ts src/modules/technician-jobs/technician-jobs.service.ts src/modules/online-booking/manage.queries.ts src/modules/online-booking/manage.service.ts src/modules/online-booking/manage.test.ts src/modules/online-booking/online-booking.schemas.ts src/modules/online-booking/online-booking.routes.ts
git commit -m "feat: homeowner moves or cancels a visit from the manage link" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The manage page (relay-web)

**Files:**
- Modify: `relay-web/src/features/booking/booking-shell.tsx`
- Create: `relay-web/src/features/booking/window-picker.tsx`
- Modify: `relay-web/src/features/booking/time-step.tsx`, `relay-web/src/features/booking/api.ts`
- Create: `relay-web/src/features/manage-booking/api.ts`, `view.ts`, `view.test.ts`,
  `manage-booking.tsx`
- Create: `relay-web/src/routes/manage.tsx`
- Modify: `relay-web/src/router.tsx`

**Interfaces:**
- Consumes (Task 2): the three routes and their JSON shapes; errors are `ApiError` with
  `status`, `code`, `message`.
- Produces: `WindowPicker({ days, initialDate?, picked, onPick })`, `type PickedTime`,
  `type OpenDay`, `manageView()`, `ManageBooking({ token })`, `ManagePage`.

All commands in this task run in `relay-web`.

- [ ] **Step 1: Write the failing view test**

Create `src/features/manage-booking/view.test.ts`:

```ts
import { expect, it } from 'vitest'
import { ApiError, NetworkError } from '@/lib/api'
import type { Visit } from './api'
import { manageView } from './view'

const visit: Visit = {
  status: 'booked',
  serviceName: 'AC repair',
  date: '2030-01-08',
  dayLabel: 'Tue, Jan 8',
  windowLabel: '8 AM–12 PM',
  address: '12 Palm St, Phoenix, AZ 85004',
  canChange: true,
  contactPhone: '(480) 555-0100',
}

it('waits while the visit loads', () => {
  expect(manageView({ error: null, data: undefined })).toEqual({ kind: 'loading' })
})

it('offers changes while the visit can still change', () => {
  expect(manageView({ error: null, data: visit })).toEqual({ kind: 'changeable', visit })
})

it('only shows the visit once it can’t change online', () => {
  const locked = { ...visit, status: 'en_route', canChange: false }
  expect(manageView({ error: null, data: locked })).toEqual({ kind: 'locked', visit: locked })
})

it('says the link is gone, with the API’s words, when it isn’t found', () => {
  const error = new ApiError(404, {
    code: 'not_found',
    message: 'This link doesn’t work anymore. Call (480) 555-0100 to make changes.',
  })
  expect(manageView({ error, data: undefined })).toEqual({
    kind: 'gone',
    message: 'This link doesn’t work anymore. Call (480) 555-0100 to make changes.',
  })
})

it('offers a retry for anything else, like being offline', () => {
  const error = new NetworkError()
  expect(manageView({ error, data: undefined })).toEqual({ kind: 'error', error })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/features/manage-booking/view.test.ts`
Expected: FAIL, cannot resolve `./api` / `./view`.

- [ ] **Step 3: The manage API hooks and the view**

Create `src/features/manage-booking/api.ts`:

```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { api } from '@/lib/api'

// The homeowner's manage page's calls to relay-api. Nobody is signed in: the token from the
// link finds the visit, and the web address finds the contractor.

const Visit = z.object({
  status: z.string(),
  serviceName: z.string(),
  date: z.string(), // '2030-01-08'
  dayLabel: z.string(), // 'Tue, Jan 8'
  windowLabel: z.string(), // '8 AM–12 PM'
  address: z.string(),
  canChange: z.boolean(), // booked, and the window hasn't started
  contactPhone: z.string(), // the contractor's, ready to show
})
export type Visit = z.infer<typeof Visit>

const Cancelled = z.object({ status: z.literal('cancelled') })

const visitKey = (token: string) => ['manage-booking', token]

export function useVisit(token: string) {
  return useQuery({
    queryKey: visitKey(token),
    queryFn: () => api.get(`/online-booking/manage/${token}`, Visit),
    retry: false, // a 404 won't fix itself
  })
}

// Answers with the visit at its new time; the open windows changed too.
export function useReschedule(token: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (time: { date: string; windowId: string }) =>
      api.post(`/online-booking/manage/${token}/reschedule`, time, Visit),
    onSuccess: (visit) => {
      queryClient.setQueryData(visitKey(token), visit)
      queryClient.invalidateQueries({ queryKey: ['online-booking', 'windows'] })
    },
  })
}

export function useCancelVisit(token: string) {
  return useMutation({
    mutationFn: () => api.post(`/online-booking/manage/${token}/cancel`, {}, Cancelled),
  })
}
```

Create `src/features/manage-booking/view.ts`:

```ts
import { ApiError } from '@/lib/api'
import type { Visit } from './api'

// What the manage page shows for the visit query, kept apart from the page so it is tested.
export type ManageView =
  | { kind: 'loading' }
  | { kind: 'gone'; message: string } // wrong link, or the visit is closed
  | { kind: 'error'; error: unknown } // offline, server down: worth a retry
  | { kind: 'changeable'; visit: Visit }
  | { kind: 'locked'; visit: Visit } // too late to change online

export function manageView(query: { error: unknown; data: Visit | undefined }): ManageView {
  if (query.data) {
    return query.data.canChange
      ? { kind: 'changeable', visit: query.data }
      : { kind: 'locked', visit: query.data }
  }
  if (query.error instanceof ApiError && query.error.status === 404) {
    return { kind: 'gone', message: query.error.message }
  }
  if (query.error) return { kind: 'error', error: query.error }
  return { kind: 'loading' }
}
```

- [ ] **Step 4: Run the view test**

Run: `npx vitest run src/features/manage-booking/view.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Pull the time picker out of the booking wizard**

In `src/features/booking/api.ts`, after the `OpenWindows` schema add:

```ts
export type OpenDay = z.infer<typeof OpenWindows>['days'][number]
```

Create `src/features/booking/window-picker.tsx`:

```tsx
import { Clock } from 'lucide-react'
import { useState } from 'react'
import type { OpenDay } from './api'
import { BookingCalendar } from './booking-calendar'
import { ChoiceCard, Panel } from './booking-ui'

export type PickedTime = { date: string; windowId: string; timeLabel: string }

// The open arrival windows: a month calendar picks the day (only days with open windows can be
// tapped), and that day's windows show below. Tapping a window only chooses it. Used by the
// booking wizard and the manage page, so both pick a time the same way. `days` is never empty.
export function WindowPicker({
  days,
  initialDate = '',
  picked,
  onPick,
}: {
  days: OpenDay[]
  initialDate?: string // the day to show first; else the soonest
  picked: PickedTime | null
  onPick: (time: PickedTime) => void
}) {
  const [pickedDate, setPickedDate] = useState(initialDate)
  const day = days.find((candidate) => candidate.date === pickedDate) ?? days[0]

  return (
    <>
      <Panel>
        <BookingCalendar
          openDates={days.map((candidate) => candidate.date)}
          selected={day.date}
          onSelect={setPickedDate}
        />
      </Panel>

      <Panel className="space-y-3">
        <h3 className="font-semibold">{day.label}</h3>
        <div className="grid grid-cols-2 gap-3">
          {day.windows.map((window) => {
            const soonest = day.date === days[0].date && window.id === day.windows[0].id
            return (
              <ChoiceCard
                key={window.id}
                selected={picked?.date === day.date && picked.windowId === window.id}
                className="relative flex items-center gap-2.5 bg-muted/50 shadow-none"
                onClick={() =>
                  onPick({
                    date: day.date,
                    windowId: window.id,
                    timeLabel: `${day.label}, ${window.label}`,
                  })
                }
              >
                <Clock className="size-4 shrink-0 text-primary" />
                <span className="text-sm font-medium">{window.label}</span>
                {soonest && (
                  <span className="absolute -top-2 right-3 rounded-full bg-primary px-2 py-0.5 text-[0.7rem] font-medium text-primary-foreground">
                    Soonest
                  </span>
                )}
              </ChoiceCard>
            )
          })}
        </div>
      </Panel>
    </>
  )
}
```

In `src/features/booking/time-step.tsx`:
- Imports: `import { CircleCheck, Zap } from 'lucide-react'` (drop `Clock`); drop the
  `BookingCalendar` import; change `import { ChoiceCard, Panel } from './booking-ui'` to
  `import { Panel } from './booking-ui'`; add
  `import { type PickedTime, WindowPicker } from './window-picker'`.
- `type TimeAnswers = Pick<Answers, 'date' | 'windowId' | 'timeLabel'>` stays (it is the same
  shape as `PickedTime`).
- Delete `const [pickedDate, setPickedDate] = useState(answers.date)` and its comment, and
  delete the `// The day whose windows show …` comment and `const day = …` line.
- Replace the whole `{days.data && day && ( <> <Panel>…BookingCalendar…</Panel> <Panel
  className="space-y-3">…windows…</Panel>` part, up to (not including) the Continue
  `<Button`, with:

```tsx
      {days.data && days.data.length > 0 && (
        <>
          <WindowPicker
            days={days.data}
            initialDate={answers.date}
            picked={picked}
            onPick={(time: PickedTime) => setPicked(time)}
          />
```

  (the Continue button, `</>` and `)}` after it stay as they are).

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Let the booking frame take another title**

In `src/features/booking/booking-shell.tsx`, change the signature to:

```tsx
export function BookingShell({
  onExit,
  title,
  intro,
  children,
}: {
  onExit?: () => void
  title?: string // default: 'Book with <contractor>'
  intro?: string // default: the booking wizard's line
  children: ReactNode
}) {
```

and use them:

```tsx
              {title ?? (branding ? `Book with ${branding.name}` : 'Book a visit')}
```

```tsx
            {intro ??
              'A few quick questions and we’ll get someone out to you. It takes about two minutes.'}
```

- [ ] **Step 7: The manage page**

Create `src/features/manage-booking/manage-booking.tsx`:

```tsx
import { CalendarClock, CircleCheck, MapPin, Wrench } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { Button, buttonVariants } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useOpenWindows } from '@/features/booking/api'
import { BookingShell } from '@/features/booking/booking-shell'
import { Panel } from '@/features/booking/booking-ui'
import { type PickedTime, WindowPicker } from '@/features/booking/window-picker'
import { useBranding } from '@/features/branding/api'
import { errorMessage } from '@/lib/errors'
import { useCancelVisit, useReschedule, useVisit, type Visit } from './api'
import { manageView } from './view'

// The page behind the link in a homeowner's confirmation: see the visit, move it to another
// open window, or cancel it. Only until the window starts; after that, call the office.
export function ManageBooking({ token }: { token: string }) {
  const { data: branding } = useBranding()
  const visit = useVisit(token)
  const reschedule = useReschedule(token)
  const cancel = useCancelVisit(token)
  const [changing, setChanging] = useState(false)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [moved, setMoved] = useState(false)

  const view = manageView(visit)

  // The visit may be locked now (the technician left) or the window just filled: show why,
  // and load the visit again.
  function onRefused(error: unknown) {
    toast.error(errorMessage(error))
    visit.refetch()
  }

  let content: ReactNode
  if (cancel.isSuccess) {
    content = (
      <Panel className="space-y-3 text-center">
        <CircleCheck className="mx-auto size-10 text-primary" />
        <p className="text-lg font-semibold">Your visit is cancelled</p>
        <p className="text-sm text-muted-foreground">We’ve sent you a text to confirm.</p>
        <Link to="/" className={buttonVariants({ className: "h-12 w-full text-base" })}>
          Book another visit
        </Link>
      </Panel>
    )
  } else if (view.kind === 'loading') {
    content = <Panel className="h-40 animate-pulse" />
  } else if (view.kind === 'gone') {
    content = (
      <Panel className="space-y-2 text-center">
        <p className="font-semibold">This link doesn’t work anymore</p>
        <p className="text-sm text-muted-foreground">{view.message}</p>
      </Panel>
    )
  } else if (view.kind === 'error') {
    content = (
      <Panel className="space-y-3">
        <p className="text-sm text-destructive">{errorMessage(view.error)}</p>
        <Button variant="outline" onClick={() => visit.refetch()}>
          Try again
        </Button>
      </Panel>
    )
  } else if (changing) {
    content = (
      <ChangeTime
        busy={reschedule.isPending}
        onBack={() => setChanging(false)}
        onConfirm={(time) =>
          reschedule.mutate(time, {
            onSuccess: () => {
              setChanging(false)
              setMoved(true)
            },
            onError: (error) => {
              setChanging(false)
              onRefused(error)
            },
          })
        }
      />
    )
  } else {
    content = (
      <>
        {moved && (
          <p className="flex items-center gap-2.5 rounded-xl bg-primary/10 px-3.5 py-3 text-sm text-primary">
            <CircleCheck className="size-4 shrink-0" />
            Your visit is moved. We’ve sent you a text with the new time.
          </p>
        )}
        <VisitSummary visit={view.visit} />
        {view.kind === 'changeable' ? (
          <div className="space-y-3">
            <Button className="h-12 w-full text-base" onClick={() => setChanging(true)}>
              Change time
            </Button>
            <Button
              variant="outline"
              className="h-12 w-full text-base"
              onClick={() => setConfirmCancel(true)}
            >
              Cancel visit
            </Button>
          </div>
        ) : (
          <Panel>
            <p className="text-sm">
              Your visit can’t be changed online anymore. Call{' '}
              <a className="font-medium underline" href={`tel:${view.visit.contactPhone}`}>
                {view.visit.contactPhone}
              </a>
              .
            </p>
          </Panel>
        )}
        <Dialog open={confirmCancel} onOpenChange={setConfirmCancel}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Cancel your visit on {view.visit.dayLabel}?</DialogTitle>
              <DialogDescription>
                Your arrival window goes to someone else. You can book again any time.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmCancel(false)}>
                Keep visit
              </Button>
              <Button
                variant="destructive"
                disabled={cancel.isPending}
                onClick={() =>
                  cancel.mutate(undefined, {
                    onSettled: () => setConfirmCancel(false),
                    onError: onRefused,
                  })
                }
              >
                Cancel visit
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </>
    )
  }

  return (
    <BookingShell
      title={branding ? `Your visit with ${branding.name}` : 'Your visit'}
      intro="Change the time or cancel, right here."
    >
      {content}
    </BookingShell>
  )
}

function VisitSummary({ visit }: { visit: Visit }) {
  return (
    <Panel className="space-y-3">
      <p className="flex items-center gap-2.5">
        <Wrench className="size-4 shrink-0 text-primary" />
        <span className="font-semibold">{visit.serviceName}</span>
      </p>
      <p className="flex items-center gap-2.5 text-sm">
        <CalendarClock className="size-4 shrink-0 text-primary" />
        {visit.dayLabel}, {visit.windowLabel}
      </p>
      <p className="flex items-center gap-2.5 text-sm">
        <MapPin className="size-4 shrink-0 text-primary" />
        {visit.address}
      </p>
    </Panel>
  )
}

// The booking wizard's time picker, with a confirm button.
function ChangeTime({
  busy,
  onBack,
  onConfirm,
}: {
  busy: boolean
  onBack: () => void
  onConfirm: (time: { date: string; windowId: string }) => void
}) {
  const days = useOpenWindows()
  const [picked, setPicked] = useState<PickedTime | null>(null)

  return (
    <div className="space-y-4">
      {days.isPending && <p className="text-muted-foreground">Loading open times…</p>}
      {days.isError && <p className="text-sm text-destructive">{errorMessage(days.error)}</p>}
      {days.data?.length === 0 && (
        <p className="rounded-2xl border border-dashed p-6 text-center text-sm text-muted-foreground">
          No open times in the next two weeks.
        </p>
      )}
      {days.data && days.data.length > 0 && (
        <WindowPicker days={days.data} picked={picked} onPick={setPicked} />
      )}
      <Button
        className="h-12 w-full text-base"
        disabled={!picked || busy}
        onClick={() => picked && onConfirm({ date: picked.date, windowId: picked.windowId })}
      >
        {picked ? `Move to ${picked.timeLabel}` : 'Pick a new time'}
      </Button>
      <Button variant="ghost" className="h-11 w-full" onClick={onBack}>
        Back
      </Button>
    </div>
  )
}
```

Create `src/routes/manage.tsx`:

```tsx
import { useParams } from 'react-router'
import { PageShell } from '@/components/page-shell'
import { useBranding } from '@/features/branding/api'
import { ManageBooking } from '@/features/manage-booking/manage-booking'
import { ApiError } from '@/lib/api'

// Public page behind the link in a booking confirmation (/manage/<token>). Like the booking
// page, the contractor comes from the web address.
export function ManagePage() {
  const { token = '' } = useParams()
  const branding = useBranding()

  if (branding.error instanceof ApiError && branding.error.status === 404) {
    return (
      <PageShell title="Contractor not found">
        <p className="text-muted-foreground">Check the web address and try again.</p>
      </PageShell>
    )
  }
  if (branding.isError) throw branding.error

  return <ManageBooking token={token} />
}
```

In `src/router.tsx`: add `import { ManagePage } from '@/routes/manage'` (in alphabetical
order with the others), and after `{ path: '/', element: <BookingPage /> },` add:

```tsx
      { path: '/manage/:token', element: <ManagePage /> },
```

- [ ] **Step 8: Typecheck, test, lint**

Run: `npm run typecheck`
Expected: no errors.
Run: `npm test`
Expected: every test passes (including the 5 new view tests).
Run: `npx biome check --write src/features/booking/booking-shell.tsx src/features/booking/window-picker.tsx src/features/booking/time-step.tsx src/features/booking/api.ts src/features/manage-booking src/routes/manage.tsx src/router.tsx`

- [ ] **Step 9: Commit**

```bash
git add src/features/booking/booking-shell.tsx src/features/booking/window-picker.tsx src/features/booking/time-step.tsx src/features/booking/api.ts src/features/manage-booking/api.ts src/features/manage-booking/view.ts src/features/manage-booking/view.test.ts src/features/manage-booking/manage-booking.tsx src/routes/manage.tsx src/router.tsx
git commit -m "feat: manage page to move or cancel a visit from the confirmation link" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Check it in the browser (with the user)

- [ ] `npm run dev` in `relay-api` and `relay-web`. Book a visit at
      `http://desert.localhost:5173`; copy the `/manage/…` link from the text printed in the
      `relay-api` terminal (or the email), and open it on `desert.localhost:5173`.
- [ ] The summary shows; **Change time** shows the calendar; confirm a new time; the notice
      shows and the summary has the new time; the dispatch board shows the job moved.
- [ ] **Cancel visit** → the dialog → **Cancel visit**; the cancelled screen shows. Open the
      link again: "This link doesn't work anymore".
- [ ] The booking wizard's time step still works (calendar, windows, Continue).
- [ ] Phone width (Chrome device toolbar, 375 px): nothing overflows.
