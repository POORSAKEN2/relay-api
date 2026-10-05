# Booking Widget and Google Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Contractors copy their booking link, a Google Business Profile link and a website
snippet from Booking settings; the snippet adds a "Book online" button that opens the booking
wizard in a popup on their own site, and bookings remember whether they came from Google or the
website button.

**Architecture:** The API gains `jobs.booked_via`, a staff route that builds the three things to
copy with `tenantUrl`, and a public, open-CORS route that gives the button its brand color. The
web app reads `?from=` into the wizard's answers (and drafts), runs the wizard in an "embed" mode
that closes its popup with one `postMessage`, refuses to render any other page inside a frame,
and builds `widget.js`, a standalone classic script, with Vite's library mode.

**Tech Stack:** relay-api: Node 22, Express 5, Drizzle ORM (Postgres), zod, cors, vitest +
supertest against the test database. relay-web: React, TanStack Query, react-router, zod,
Vite 8 (Rolldown), vite-plugin-pwa, vitest (node environment, no DOM library).

**Spec:** `relay-api/docs/superpowers/specs/2026-10-05-booking-widget-design.md`

## Global Constraints

- Branch `feat/booking-widget` in **both** repos. relay-api already has it (cut from
  `feat/waitlist-offer`); create it in relay-web in Task 4, from relay-web's
  `feat/waitlist-offer`. Leave the user's uncommitted `relay-api/.env.example` and untracked
  `relay-web/src/features/auth/landing.test.ts` alone.
- `booked_via` values, exactly: `'google'`, `'widget'`; null otherwise. Constant name
  `BOOKED_VIA` in both repos.
- Links, from `tenantUrl(tenant, path)`: `'/'`, `'/?from=google'`, and the snippet
  `<script src="<tenantUrl(tenant, '/widget.js')>" async></script>`.
- The popup's wizard address: `<booking origin>/?embed=1&from=widget`. The one message, exactly:
  `'relay:close'`, posted to `window.parent` with target origin `'*'`.
- Only `/` and `/manage/:token` may render inside a frame.
- Widget endpoint: `GET /api/online-booking/widget?host=<hostname>` →
  `{ primaryColor, open }`, `Access-Control-Allow-Origin: *`, no credentials,
  `Cache-Control: public, max-age=300`.
- Copy wording, exactly: card title "Share your booking page"; rows "Your booking link",
  "Google Business Profile", "Website button"; Google help "In your Google Business Profile, open
  Edit profile → Booking, and add this as your appointment link."; snippet help "Paste this just
  before `</body>` on every page of your website. It adds a ‘Book online’ button in your brand
  colors."; framed notice "Relay can’t be shown inside another site."; badge suffixes
  "from Google", "from your website". Typographic quotes and apostrophes in UI copy.
- Comments in plain English, matching the surrounding code. No new dependencies.
- Every commit message ends with:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- Before each commit, in the repo you changed: `npm run typecheck`, and
  `npx biome check --line-ending=auto <changed files>` (new files written with LF:
  `--line-ending=lf`). `npm run lint` fails on every file of this Windows checkout (CRLF), and in
  relay-web `npm test`/`npm run typecheck` also fail on the user's untracked `landing.test.ts`:
  those failures are known; nothing else may fail.

## Rulings made while planning (deviations from the spec)

- **No `bookingOpen` / "Your booking page is off" note.** Staff of a suspended contractor can't
  sign in (`accounts.queries.ts`, `ne(tenants.status, 'suspended')`), so the note could never
  show. `GET /settings/booking-links` returns only the three values.
- **The badge shows in the dispatch job drawer only.** `routes/job.tsx` is the technician's job
  page; the spec's "job page" meant the office's view of the job, which is the drawer.
- **Validation errors are `validation_failed`** (the error handler's code), not
  `validation_error` as the spec wrote.
- **The popup's frame is rebuilt on every open**, not kept after the first tap, so reopening never
  shows the last visit's "You're booked" or "You can close this page" screen.
- **No "link back to the contractor's site" to hide.** The wizard's only way back is its exit,
  which in embed mode closes the popup.
- **Web tests cover pure helpers only** (`vitest` runs in node with no DOM library, and no new
  dependencies are allowed). DOM behavior (button, popup, focus, notice) is checked in Task 8.
- **The service worker needs no change for the contractor's site** (a service worker only
  controls its own origin's pages); `widget.js` is still left out of its precache so the preview
  page never runs a stale copy.

## Review Focus

1. **The snippet is pasted twice, or the page adds it again.** Expected: one button. Guarded by a
   window mark in `widget.ts`; checked in Task 8.
2. **A homeowner books in the popup, closes it, and opens it again.** Expected: a fresh wizard at
   step 1, not the booked screen. Checked in Task 8.
3. **A booking started from Google, stopped, and finished later from the recovery text** (no
   `?from=` on that link). Expected: still credited to Google. Test in Task 1.
4. **Any staff page (dashboard, settings, sign-in, admin, the preview) loaded inside another
   site's frame.** Expected: only the notice. Test in Task 5 (`canBeFramed`), checked in Task 8.
5. **A message from another origin, or a lookalike message, reaches the contractor's page.**
   Expected: the popup stays open. Test in Task 6 (`isCloseMessage`).

## File map

relay-api:

- Modify `src/db/schema.ts`: `BOOKED_VIA`, `jobs.bookedVia` and its check, `DraftAnswers.bookedVia`.
- Create `drizzle/0015_jobs_booked_via.sql` (generated) and its snapshot/journal.
- Modify `src/modules/online-booking/online-booking.schemas.ts`: `bookedVia` on `BookingInput`
  and `DraftAnswersInput`.
- Modify `src/modules/online-booking/online-booking.service.ts`: `bookVisit` stores it.
- Modify `src/modules/dispatch/dispatch.queries.ts`: `findJobDetail` returns it.
- Modify `src/modules/settings/settings.service.ts`, `settings.routes.ts`: `getBookingLinks`.
- Create `src/modules/online-booking/widget.routes.ts`: the public widget route.
- Modify `src/app.ts`: mount it before the cookie CORS.
- Create `docs/framing-todo.md`: the hosting header to add later.
- Tests: `online-booking.test.ts`, `booking-drafts.test.ts`, `dispatch.test.ts`,
  `settings.test.ts`, create `widget.test.ts`.

relay-web:

- Modify `src/features/dispatch/api.ts`, `labels.ts`, `job-drawer.tsx`: `BOOKED_VIA`, the badge.
- Modify `src/features/booking/api.ts`, `steps.ts`, `booking-flow.tsx`, `details-step.tsx`,
  `booked-screen.tsx`: `?from=`, `bookedVia`, embed mode.
- Create `src/lib/framing.ts`, `src/components/framed-notice.tsx`; modify
  `src/components/app-layout.tsx`: the framing guard.
- Create `src/widget/widget-logic.ts`, `src/widget/widget.ts`; modify `vite.config.ts`.
- Create `src/features/settings/copy.ts`, `src/features/settings/share-card.tsx`,
  `src/routes/widget-preview.tsx`; modify `src/features/settings/api.ts`,
  `src/routes/settings.tsx`, `src/router.tsx`.
- Tests: `steps.test.ts`, create `src/lib/framing.test.ts`, `src/widget/widget-logic.test.ts`,
  `src/features/settings/copy.test.ts`.

---

### Task 1: A booking remembers where it came from (API)

**Files:**
- Modify: `relay-api/src/db/schema.ts` (after `JOB_SOURCES` ~line 585; `jobs` ~596; `DraftAnswers` ~886)
- Create: `relay-api/drizzle/0015_jobs_booked_via.sql` (generated)
- Modify: `relay-api/src/modules/online-booking/online-booking.schemas.ts` (`DraftAnswersInput`, `BookingInput`)
- Modify: `relay-api/src/modules/online-booking/online-booking.service.ts` (`bookVisit`)
- Modify: `relay-api/src/modules/dispatch/dispatch.queries.ts` (`findJobDetail`)
- Test: `relay-api/src/modules/online-booking/online-booking.test.ts`, `booking-drafts.test.ts`, `relay-api/src/modules/dispatch/dispatch.test.ts`

**Interfaces:**
- Produces: `BOOKED_VIA = ['google', 'widget'] as const` (schema.ts); `jobs.bookedVia`;
  `BookingInput.bookedVia?`, `DraftAnswersInput.answers.bookedVia?`; `GET /api/jobs/:jobId` →
  `job.bookedVia: 'google' | 'widget' | null`.

- [ ] **Step 1: Write the failing tests**

In `online-booking.test.ts`, inside `describe('POST /api/online-booking/bookings', ...)`, add:

```ts
  it('remembers where the homeowner found the booking page', async () => {
    const shop = await createServingShop()
    await post('bookings', bookingBody(shop, { bookedVia: 'google' })).expect(201)
    await post('bookings', bookingBody(shop, { bookedVia: 'widget' })).expect(201)
    await post('bookings', bookingBody(shop, { windowId: shop.tueAfternoon.id })).expect(201)

    const booked = await db.select({ bookedVia: jobs.bookedVia }).from(jobs)
    expect(new Set(booked.map((job) => job.bookedVia))).toEqual(new Set(['google', 'widget', null]))
  })

  it('refuses a bookedVia it doesn’t know', async () => {
    const shop = await createServingShop()

    const res = await post('bookings', bookingBody(shop, { bookedVia: 'facebook' })).expect(400)
    expect(res.body.error.code).toBe('validation_failed')
    expect(await db.select().from(jobs)).toEqual([])
  })
```

In `booking-drafts.test.ts`, inside `describe('GET and PATCH /api/online-booking/drafts/:token', ...)`,
add (add `jobs` to the `../../db/schema.ts` import if it isn't there):

```ts
  it('credits a booking finished later to where the draft began', async () => {
    const shop = await createServingShop()
    const { body } = await call('post', 'drafts').send(draftBody()).expect(201)
    await call('patch', `drafts/${body.token}`)
      .send({ answers: { bookedVia: 'google' } })
      .expect(200)
    expect((await call('get', `drafts/${body.token}`).expect(200)).body.answers).toEqual({
      bookedVia: 'google',
    })

    // The recovery text's link has no ?from=, so the booking doesn't send bookedVia.
    await call('post', 'bookings')
      .send(bookingBody(shop, { draftToken: body.token }))
      .expect(201)

    const [job] = await db.select().from(jobs)
    expect(job.bookedVia).toBe('google')
  })
```

In `dispatch.test.ts`, in the `describe` that holds the `GET /api/jobs/${job.id}` tests
(around line 169), add:

```ts
  it('says where an online booking came from', async () => {
    const shop = await createShop('desert')
    const job = await createJob(shop, { source: 'web', bookedVia: 'google' })

    const res = await request(app).get(`/api/jobs/${job.id}`).set('Cookie', shop.cookie).expect(200)
    expect(res.body.job).toMatchObject({ source: 'web', bookedVia: 'google' })
  })
```

- [ ] **Step 2: Run them to check they fail**

Run (in `relay-api`): `npx vitest run src/modules/online-booking src/modules/dispatch -t "where"`
Expected: FAIL. TypeScript/runtime errors that `bookedVia` doesn't exist on `jobs`; the
facebook test may fail with 201 instead of 400.

- [ ] **Step 3: The column and the constant**

In `src/db/schema.ts`, after `JOB_SOURCES`:

```ts
// Where the homeowner found the booking page, when it is known: the link on the contractor's
// Google Business Profile, or the button on their own website (widget.js).
export const BOOKED_VIA = ['google', 'widget'] as const
```

In `jobs`, after `source`:

```ts
    bookedVia: text('booked_via', { enum: BOOKED_VIA }), // null = the plain link, or not known
```

and with the other checks, after `jobs_source_valid`:

```ts
    check('jobs_booked_via_valid', oneOf(t.bookedVia, BOOKED_VIA)),
```

In `DraftAnswers`, add the last key:

```ts
  bookedVia?: (typeof BOOKED_VIA)[number]
```

- [ ] **Step 4: Generate and run the migration**

Run (in `relay-api`): `npm run db:generate -- --name jobs_booked_via`
Expected: `drizzle/0015_jobs_booked_via.sql` with `ALTER TABLE "jobs" ADD COLUMN "booked_via" text;`
and `ADD CONSTRAINT "jobs_booked_via_valid" CHECK ...`, nothing else.

Run: `npm run db:migrate` (development database). Expected: `Migrations applied`. The test
database is migrated by the test setup.

- [ ] **Step 5: Accept and store it**

In `online-booking.schemas.ts`, import `BOOKED_VIA` from `../../db/schema.ts` (beside the
existing schema imports). In `DraftAnswersInput`'s `answers` object, add the last key:

```ts
    bookedVia: z.enum(BOOKED_VIA).optional(),
```

In `BookingInput`, after `offerToken`:

```ts
  bookedVia: z.enum(BOOKED_VIA).optional(), // where the homeowner found the booking page
```

In `online-booking.service.ts`, `bookVisit`: move the draft lookup up, to just before
`const customer = await findOrAddCustomer(...)`, as:

```ts
    // The draft this booking finishes. An unknown token is ignored: a draft must never stop a
    // booking.
    const draft = input.draftToken
      ? await queries.findOpenDraft(tenant.id, input.draftToken, tx)
      : undefined
```

and remove the old `const draft = ...` lines below (keep `if (draft) await queries.markDraftBooked(...)`
where it is, and change the comment above it to `// The booking this draft was for is made.`).
In the `insertBookedJob` values, after `source: 'web',` add:

```ts
        // A link's ?from= wins; a booking finished from a draft keeps where the draft began.
        bookedVia: input.bookedVia ?? draft?.answers.bookedVia ?? null,
```

In `dispatch.queries.ts`, `findJobDetail`, after `source: jobs.source,`:

```ts
      bookedVia: jobs.bookedVia,
```

- [ ] **Step 6: Run the tests to check they pass**

Run: `npx vitest run src/modules/online-booking src/modules/dispatch`
Expected: PASS, all files.

- [ ] **Step 7: Typecheck, lint, commit**

```bash
npm run typecheck
git add src/db/schema.ts drizzle src/modules/online-booking src/modules/dispatch
git commit -m "feat: a booking remembers whether it came from Google or the website button

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The booking links for Booking settings (API)

**Files:**
- Modify: `relay-api/src/modules/settings/settings.service.ts`
- Modify: `relay-api/src/modules/settings/settings.routes.ts`
- Test: `relay-api/src/modules/settings/settings.test.ts`

**Interfaces:**
- Consumes: `tenantUrl` (`src/lib/tenant-url.ts`), `findTenantById` (`branding.queries.ts`).
- Produces: `GET /api/settings/booking-links` (owner, office) →
  `{ bookingUrl: string, googleUrl: string, widgetSnippet: string }`.

- [ ] **Step 1: Write the failing tests**

Append to `settings.test.ts`:

```ts
describe('GET /api/settings/booking-links', () => {
  function getLinks(shop: Shop) {
    return request(app).get('/api/settings/booking-links').set('Cookie', shop.cookie)
  }

  it('gives the booking link, the Google link and the website snippet', async () => {
    const shop = await createShop('desert')

    const res = await getLinks(shop).expect(200)
    expect(res.body).toEqual({
      bookingUrl: 'https://desert.localhost/',
      googleUrl: 'https://desert.localhost/?from=google',
      widgetSnippet: '<script src="https://desert.localhost/widget.js" async></script>',
    })
  })

  it('uses the contractor’s own domain once it is verified', async () => {
    const shop = await createShop('desert')
    const where = eq(tenants.id, shop.tenant.id)
    await db.update(tenants).set({ customDomain: 'book.desertbreeze.com' }).where(where)
    expect((await getLinks(shop).expect(200)).body.bookingUrl).toBe('https://desert.localhost/')

    await db.update(tenants).set({ customDomainVerifiedAt: new Date() }).where(where)
    expect((await getLinks(shop).expect(200)).body).toMatchObject({
      bookingUrl: 'https://book.desertbreeze.com/',
      googleUrl: 'https://book.desertbreeze.com/?from=google',
    })
  })

  it('is for the contractor’s staff only', async () => {
    const shop = await createShop('desert')
    const technician = await createUser('technician', shop.tenant.id)

    await request(app).get('/api/settings/booking-links').expect(401)
    await request(app)
      .get('/api/settings/booking-links')
      .set('Cookie', await signIn(technician.email))
      .expect(403)
  })
})
```

- [ ] **Step 2: Run them to check they fail**

Run: `npx vitest run src/modules/settings/settings.test.ts -t "booking-links"`
Expected: FAIL, 404 `Route not found` where 200/401/403 was expected.

- [ ] **Step 3: Build the links**

In `settings.service.ts`, add imports `import { tenantUrl } from '../../lib/tenant-url.ts'` and
`import { findTenantById } from '../branding/branding.queries.ts'`, and append:

```ts
// The contractor's booking page, ready to share: the plain link, the link for their Google
// Business Profile (bookings from it are credited to Google), and the snippet that adds the
// booking button to their own website. tenantUrl uses their own domain once it is verified.
export async function getBookingLinks(tenantId: string) {
  const tenant = await findTenantById(tenantId)
  if (!tenant) throw new Error(`Contractor ${tenantId} not found`)
  return {
    bookingUrl: tenantUrl(tenant, '/'),
    googleUrl: tenantUrl(tenant, '/?from=google'),
    widgetSnippet: `<script src="${tenantUrl(tenant, '/widget.js')}" async></script>`,
  }
}
```

In `settings.routes.ts`, after the `GET /settings/booking` route:

```ts
settingsRoutes.get('/settings/booking-links', staff, async (req, res) => {
  res.json(await settings.getBookingLinks(tenantOf(req.user!)))
})
```

- [ ] **Step 4: Run the tests to check they pass**

Run: `npx vitest run src/modules/settings`
Expected: PASS. If the technician request isn't 403, check what `requireRole` answers for a
signed-in user of the wrong role in `src/middleware/auth.ts` and match the test to it (and
ledger the ruling).

- [ ] **Step 5: Typecheck, lint, commit**

```bash
npm run typecheck
git add src/modules/settings
git commit -m "feat: booking settings give the booking, Google and website-button links

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The button's look, for any website (API)

**Files:**
- Create: `relay-api/src/modules/online-booking/widget.routes.ts`
- Modify: `relay-api/src/app.ts`
- Test: `relay-api/src/modules/online-booking/widget.test.ts`

**Interfaces:**
- Consumes: `parseTenantHost` (`src/middleware/tenant.ts`), `findTenantByHost`
  (`branding.queries.ts`), `getBranding`, `DEFAULT_COLORS` (`branding.service.ts`).
- Produces: `GET /api/online-booking/widget?host=<hostname>` →
  `{ primaryColor: string, open: boolean }`, or 404.

- [ ] **Step 1: Write the failing tests**

Create `src/modules/online-booking/widget.test.ts`:

```ts
import { eq } from 'drizzle-orm'
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'
import { createShop, createUser, resetDb } from '../../../test/helpers.ts'
import { createApp } from '../../app.ts'
import { db } from '../../db/client.ts'
import { brandingVersions, tenants } from '../../db/schema.ts'
import { DEFAULT_COLORS } from '../branding/branding.service.ts'

const app = createApp()

beforeEach(resetDb)

// Asked the way widget.js asks from a contractor's own website: another origin, no cookie.
function widget(host: string) {
  return request(app)
    .get('/api/online-booking/widget')
    .query({ host })
    .set('Origin', 'https://desertbreezeair.com')
}

describe('GET /api/online-booking/widget', () => {
  it('gives the button the contractor’s brand color, to any website', async () => {
    const shop = await createShop('desert')
    const admin = await createUser('superadmin', null)
    await db.insert(brandingVersions).values({
      tenantId: shop.tenant.id,
      primaryColor: '#0f766e',
      accentColor: '#f59e0b',
      createdBy: admin.id,
    })

    const res = await widget('desert.localhost').expect(200)
    expect(res.body).toEqual({ primaryColor: '#0f766e', open: true })
    expect(res.headers['access-control-allow-origin']).toBe('*')
    expect(res.headers['access-control-allow-credentials']).toBeUndefined()
    expect(res.headers['cache-control']).toBe('public, max-age=300')
  })

  it('uses the default color before the contractor has one', async () => {
    await createShop('desert')

    const res = await widget('desert.localhost').expect(200)
    expect(res.body).toEqual({ primaryColor: DEFAULT_COLORS.primaryColor, open: true })
  })

  it('says the booking page is off for a suspended contractor', async () => {
    const shop = await createShop('desert')
    await db.update(tenants).set({ status: 'suspended' }).where(eq(tenants.id, shop.tenant.id))

    const res = await widget('desert.localhost').expect(200)
    expect(res.body.open).toBe(false)
  })

  it('knows no other address', async () => {
    await createShop('desert')

    await widget('nobody.localhost').expect(404)
    await widget('localhost').expect(404)
    await request(app).get('/api/online-booking/widget').expect(400)
  })
})
```

- [ ] **Step 2: Run them to check they fail**

Run: `npx vitest run src/modules/online-booking/widget.test.ts`
Expected: FAIL. The first three get 404 `Route not found`; the last one's 400 gets 404.

- [ ] **Step 3: The route**

Create `src/modules/online-booking/widget.routes.ts`:

```ts
import cors from 'cors'
import { Router } from 'express'
import { z } from 'zod'
import { env } from '../../config/env.ts'
import { HttpError } from '../../lib/http-error.ts'
import { parseTenantHost } from '../../middleware/tenant.ts'
import { findTenantByHost } from '../branding/branding.queries.ts'
import { getBranding } from '../branding/branding.service.ts'

// The booking button on a contractor's own website (relay-web's widget.js) asks how to look.
// Any website may ask, so this route has its own open CORS rule and is mounted before the
// app's cookie CORS (app.ts). It answers with public facts only. `host` is the booking page's
// hostname, sent in the address rather than as X-Tenant-Host so the browser needs no
// preflight.
export const widgetRoutes = Router()

const WidgetQuery = z.object({ host: z.string().min(1).max(253) })

widgetRoutes.get('/api/online-booking/widget', cors({ origin: '*' }), async (req, res) => {
  const { host } = WidgetQuery.parse(req.query)
  const where = parseTenantHost(host, env.APP_DOMAIN)
  const tenant = where ? await findTenantByHost(where) : undefined
  if (!tenant) throw new HttpError(404, 'not_found', 'Contractor not found')
  const { primaryColor } = await getBranding(tenant)
  // A new brand color reaches the button within 5 minutes.
  res.set('Cache-Control', 'public, max-age=300')
  res.json({ primaryColor, open: tenant.status !== 'suspended' })
})
```

In `src/app.ts`, import `import { widgetRoutes } from './modules/online-booking/widget.routes.ts'`
and mount it right before the `app.use(cors({ origin: checkOrigin, ... }))` line:

```ts
  // Before the cookie CORS below: any website may ask for the booking button's look.
  app.use(widgetRoutes)
```

- [ ] **Step 4: Run the tests to check they pass**

Run: `npx vitest run src/modules/online-booking/widget.test.ts`
Expected: PASS (4 tests). If the 400 case returns 404 instead, the error handler isn't reached
for this router: check `app.use(widgetRoutes)` is inside `createApp()` after `pinoHttp`.

- [ ] **Step 5: Run all the API tests**

Run: `npm test`
Expected: PASS for everything.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
npm run typecheck
git add src/app.ts src/modules/online-booking/widget.routes.ts src/modules/online-booking/widget.test.ts
git commit -m "feat: the booking button's look, open to any website

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `?from=` in the wizard, and the badge (web)

**Files:**
- Modify: `relay-web/src/features/dispatch/api.ts`, `labels.ts`, `job-drawer.tsx`
- Modify: `relay-web/src/features/booking/api.ts`, `steps.ts`, `booking-flow.tsx`, `details-step.tsx`
- Test: `relay-web/src/features/booking/steps.test.ts`

**Interfaces:**
- Consumes: Task 1's `bookedVia` on bookings, drafts and job details.
- Produces: `BOOKED_VIA`, `type BookedVia` (`features/dispatch/api.ts`);
  `Answers.bookedVia: BookedVia | ''`; `bookedViaFrom(params: URLSearchParams): BookedVia | ''`
  (`steps.ts`); `BOOKED_VIA_LABELS` (`dispatch/labels.ts`).

- [ ] **Step 1: Create the branch**

```bash
cd ../relay-web
git switch feat/waitlist-offer
git switch -c feat/booking-widget
```

- [ ] **Step 2: Write the failing tests**

In `src/features/booking/steps.test.ts`, add `bookedViaFrom` to the `./steps` import, then
append:

```ts
it('keeps only the link sources it knows', () => {
  expect(bookedViaFrom(new URLSearchParams('from=google'))).toBe('google')
  expect(bookedViaFrom(new URLSearchParams('embed=1&from=widget'))).toBe('widget')
  expect(bookedViaFrom(new URLSearchParams('from=facebook'))).toBe('')
  expect(bookedViaFrom(new URLSearchParams(''))).toBe('')
})

it('keeps where the homeowner came from in the draft, and back', () => {
  expect(draftAnswers({ ...UP_TO_TIME, bookedVia: 'google' }).bookedVia).toBe('google')
  expect(draftAnswers(UP_TO_TIME).bookedVia).toBeUndefined()

  const draft = {
    name: 'Sam Reed',
    phone: '+14805550199',
    zip: '85004',
    consent: true,
    answers: { bookedVia: 'widget' as const },
  }
  expect(answersFromDraft(draft, []).bookedVia).toBe('widget')
})
```

- [ ] **Step 3: Run them to check they fail**

Run (in `relay-web`): `npx vitest run src/features/booking/steps.test.ts`
Expected: FAIL, `bookedViaFrom is not a function`.

- [ ] **Step 4: The constant, the answers and the draft**

In `src/features/dispatch/api.ts`, after `JobSource`:

```ts
// Where the homeowner found the booking page: the contractor's Google Business Profile link, or
// the button on their own website. Null when it isn't known.
export const BOOKED_VIA = ['google', 'widget'] as const
export type BookedVia = (typeof BOOKED_VIA)[number]
```

and in `JobDetail`'s `job` object, after `source`:

```ts
    bookedVia: z.enum(BOOKED_VIA).nullable(),
```

In `src/features/booking/api.ts`, add `BOOKED_VIA` and `type BookedVia` to the
`@/features/dispatch/api` import. In `Draft`'s `answers` object, add the last key:

```ts
    bookedVia: z.enum(BOOKED_VIA).optional(),
```

and in `BookingInput`, after `offerToken`:

```ts
  bookedVia?: BookedVia // where the homeowner found the booking page
```

In `src/features/booking/steps.ts`, change the first import to
`import { BOOKED_VIA, type BookedVia, type SystemType } from '@/features/dispatch/api'`.
Add to `Answers`, last:

```ts
  bookedVia: BookedVia | '' // where they found the booking page (a link's ?from=), '' = not known
```

to `NO_ANSWERS`, last: `bookedVia: '',`; to the object `draftAnswers` returns, last:
`bookedVia: answers.bookedVia || undefined,`; and to the object `answersFromDraft` returns,
last: `bookedVia: saved.bookedVia ?? '',`. Append:

```ts
// Where the homeowner found the booking page, from the link's `?from=`: the contractor's Google
// Business Profile or the button on their website. Anything else is ignored.
export function bookedViaFrom(params: URLSearchParams): BookedVia | '' {
  const from = params.get('from')
  return BOOKED_VIA.find((value) => value === from) ?? ''
}
```

- [ ] **Step 5: Run the tests to check they pass**

Run: `npx vitest run src/features/booking/steps.test.ts`
Expected: PASS.

- [ ] **Step 6: Read `?from=` and send it**

In `booking-flow.tsx`, add `bookedViaFrom` to the `./steps` import and `type BookedVia` from
`@/features/dispatch/api`. In `BookingFlow`, after the `fromTextLink` line:

```tsx
  const [bookedVia] = useState(() => bookedViaFrom(params))
```

and pass `bookedVia={bookedVia}` to `<BookingWizard … />`. In `BookingWizard`, add the prop
`bookedVia` (type `BookedVia | ''`) and replace the `answers` state with:

```tsx
  const [answers, setAnswers] = useState<Answers>(() => {
    const start = offer
      ? answersFromOffer(offer, serviceIds)
      : savedDraft
        ? answersFromDraft(savedDraft, serviceIds)
        : NO_ANSWERS
    // A link's ?from= wins over what a saved draft remembered.
    return bookedVia ? { ...start, bookedVia } : start
  })
```

In `bookAgain`, keep it: add `bookedVia: answers.bookedVia,` to the object passed to
`setAnswers`.

In `details-step.tsx`, in `book.mutate({ … })`, after `offerToken`:

```tsx
        bookedVia: answers.bookedVia || undefined,
```

- [ ] **Step 7: The badge**

In `src/features/dispatch/labels.ts`, add `BookedVia` to the `./api` type import and add after
`SOURCE`:

```ts
// After the source badge: "Booked online · from Google".
export const BOOKED_VIA_LABELS: Record<BookedVia, string> = {
  google: 'from Google',
  widget: 'from your website',
}
```

In `job-drawer.tsx`, import `BOOKED_VIA_LABELS` beside `SOURCE`, and change the source line to:

```tsx
            <SourceIcon className="size-3.5" aria-hidden /> {SOURCE[job.source].label}
            {job.bookedVia && ` · ${BOOKED_VIA_LABELS[job.bookedVia]}`}
```

- [ ] **Step 8: Tests, typecheck, lint, commit**

Run: `npx vitest run src/features` and `npm run typecheck`
Expected: PASS, apart from the untracked `landing.test.ts`.

```bash
git add src/features/booking src/features/dispatch
git commit -m "feat: bookings from the Google link or website button say so

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Embed mode and the framing guard (web)

**Files:**
- Create: `relay-web/src/lib/framing.ts`, `relay-web/src/components/framed-notice.tsx`
- Modify: `relay-web/src/components/app-layout.tsx`
- Modify: `relay-web/src/features/booking/booking-flow.tsx`, `booked-screen.tsx`
- Create: `relay-api/docs/framing-todo.md`
- Test: `relay-web/src/lib/framing.test.ts`

**Interfaces:**
- Produces: `canBeFramed(pathname: string): boolean`,
  `isFramed(win?: Pick<Window, 'top' | 'self'>): boolean`, `CLOSE_MESSAGE = 'relay:close'`,
  `closeEmbed(win?: Pick<Window, 'parent'>): void` in `src/lib/framing.ts`. `widget-logic.ts`
  (Task 6) imports `CLOSE_MESSAGE`.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/framing.test.ts`:

```ts
import { expect, it, vi } from 'vitest'
import { CLOSE_MESSAGE, canBeFramed, closeEmbed, isFramed } from './framing'

it('lets only the booking and manage pages be framed', () => {
  expect(canBeFramed('/')).toBe(true)
  expect(canBeFramed('/manage/abc123')).toBe(true)
  for (const path of [
    '/dashboard',
    '/settings',
    '/sign-in',
    '/admin',
    '/jobs/1',
    '/widget-preview',
    '/manage/',
    '/manage/abc/extra',
  ]) {
    expect(canBeFramed(path), path).toBe(false)
  }
})

it('knows when the page is in a frame', () => {
  const page = {} as Window
  expect(isFramed({ top: page, self: page })).toBe(false)
  expect(isFramed({ top: {} as Window, self: page })).toBe(true)
  // Some browsers won't even say: that also means framed.
  const blocked = {
    self: page,
    get top(): Window {
      throw new Error('Blocked a frame from accessing a cross-origin frame')
    },
  }
  expect(isFramed(blocked)).toBe(true)
})

it('asks the page around it to close the popup, and says nothing else', () => {
  const postMessage = vi.fn()
  closeEmbed({ parent: { postMessage } as unknown as Window })
  expect(postMessage).toHaveBeenCalledExactlyOnceWith('relay:close', '*')
  expect(CLOSE_MESSAGE).toBe('relay:close')
})
```

- [ ] **Step 2: Run them to check they fail**

Run: `npx vitest run src/lib/framing.test.ts`
Expected: FAIL, "Cannot find module './framing'" (or "Failed to resolve import").

- [ ] **Step 3: The framing rules**

Create `src/lib/framing.ts`:

```ts
// Relay's pages inside other websites. Only the booking wizard and the manage page may be shown
// in a frame (the booking button on a contractor's website opens the wizard in one); every
// other page refuses, so a staff screen can't be hidden inside someone else's site.

const FRAMEABLE = [/^\/$/, /^\/manage\/[^/]+$/]

export function canBeFramed(pathname: string): boolean {
  return FRAMEABLE.some((pattern) => pattern.test(pathname))
}

// True inside a frame. A browser that won't tell (some do, across sites) throws, which also
// means framed.
export function isFramed(win: Pick<Window, 'top' | 'self'> = window): boolean {
  try {
    return win.top !== win.self
  } catch {
    return true
  }
}

// The one message the wizard sends to the page around it: "close the popup". It carries nothing
// about the homeowner, so it can go to whatever site the popup is on.
export const CLOSE_MESSAGE = 'relay:close'

export function closeEmbed(win: Pick<Window, 'parent'> = window) {
  win.parent.postMessage(CLOSE_MESSAGE, '*')
}
```

- [ ] **Step 4: Run them to check they pass**

Run: `npx vitest run src/lib/framing.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: The notice, in every layout**

Create `src/components/framed-notice.tsx`:

```tsx
// Shown instead of a Relay page that was loaded inside another website (lib/framing.ts).
export function FramedNotice() {
  return (
    <main className="flex min-h-svh items-center justify-center p-6 text-center">
      <div className="space-y-3">
        <p>Relay can’t be shown inside another site.</p>
        <a
          className="text-sm underline underline-offset-4"
          href={location.href}
          target="_blank"
          rel="noopener"
        >
          Open Relay in its own tab
        </a>
      </div>
    </main>
  )
}
```

In `src/components/app-layout.tsx`, import `useLocation` from `react-router` (beside `Outlet`),
`FramedNotice` from `@/components/framed-notice`, and `canBeFramed, isFramed` from
`@/lib/framing`. In `AppLayout`, add `const { pathname } = useLocation()` after the
`useBranding()` line, and after the `useEffect(...)` block (hooks first):

```tsx
  // Only the booking and manage pages may sit inside another website.
  if (isFramed() && !canBeFramed(pathname)) return <FramedNotice />
```

- [ ] **Step 6: Embed mode in the wizard**

In `booked-screen.tsx`, add an optional prop `onDone?: () => void` (comment: shown in the
popup on a contractor's website, where Done closes it), and render, right before the existing
"book again" `<Button>`:

```tsx
      {onDone && (
        <Button className="h-12 w-full text-base" onClick={onDone}>
          Done
        </Button>
      )}
```

In `booking-flow.tsx`, import `closeEmbed, isFramed` from `@/lib/framing`. In `BookingFlow`,
after the `bookedVia` line:

```tsx
  // In the popup the booking button opens on a contractor's website (`?embed=1`, in a frame).
  const [embedded] = useState(() => params.get('embed') === '1' && isFramed())
```

and pass `embedded={embedded}` to `<BookingWizard … />`; add the prop `embedded: boolean` to
`BookingWizard`. At the start of `leave()`, after `setExiting(false)`:

```tsx
    // In the popup: close it. The contractor's site is right behind it.
    if (embedded) return closeEmbed()
```

and pass `onDone={embedded ? () => closeEmbed() : undefined}` to `<BookedScreen … />`.

- [ ] **Step 7: The hosting to-do (relay-api)**

Create `relay-api/docs/framing-todo.md`:

```md
# Framing: hosting to-do

relay-web refuses to show its pages inside another website, except the booking page (`/`) and
the manage page (`/manage/:token`), which the booking button on a contractor's site opens in a
popup (`relay-web/src/lib/framing.ts`). That check runs in the browser. When the hosting
configuration is set up (Render), also send this header on every path except `/`,
`/manage/*` and `/widget.js`:

    Content-Security-Policy: frame-ancestors 'self'
```

- [ ] **Step 8: Tests, typecheck, lint, commit (both repos)**

Run (in `relay-web`): `npx vitest run src/lib src/features` and `npm run typecheck`
Expected: PASS, apart from the untracked `landing.test.ts`.

```bash
git add src/lib/framing.ts src/lib/framing.test.ts src/components src/features/booking
git commit -m "feat: the booking wizard closes its popup, and staff pages refuse to be framed

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
cd ../relay-api
git add docs/framing-todo.md
git commit -m "docs: the frame-ancestors header to add with the hosting setup

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
cd ../relay-web
```

---

### Task 6: `widget.js` (web)

**Files:**
- Create: `relay-web/src/widget/widget-logic.ts`, `relay-web/src/widget/widget.ts`
- Modify: `relay-web/vite.config.ts`
- Test: `relay-web/src/widget/widget-logic.test.ts`

**Interfaces:**
- Consumes: Task 3's `GET /api/online-booking/widget?host=`; `CLOSE_MESSAGE` (Task 5);
  `contrastRatio` (`features/branding/color.ts`, which imports nothing).
- Produces: `/widget.js` in development and `dist/widget.js` from `vite build`; the popup
  opens `<booking origin>/?embed=1&from=widget`.

- [ ] **Step 1: Write the failing tests**

Create `src/widget/widget-logic.test.ts`:

```ts
import { expect, it } from 'vitest'
import { bookingPageOf, buttonTextColor, DEFAULT_LOOK, isCloseMessage, readLook } from './widget-logic'

it('finds the booking page from where the script came from', () => {
  expect(bookingPageOf('https://desert.relay.app/widget.js')).toEqual({
    origin: 'https://desert.relay.app',
    hostname: 'desert.relay.app',
  })
  expect(bookingPageOf('http://desert.localhost:5173/widget.js?v=2')).toEqual({
    origin: 'http://desert.localhost:5173',
    hostname: 'desert.localhost',
  })
  expect(bookingPageOf('')).toBeNull()
  expect(bookingPageOf('data:text/javascript,1')).toBeNull()
})

it('picks the button text that reads better', () => {
  expect(buttonTextColor('#1d4ed8')).toBe('#ffffff')
  expect(buttonTextColor('#fde047')).toBe('#111827')
})

it('closes only for its own booking page’s close message', () => {
  const origin = 'https://desert.relay.app'
  expect(isCloseMessage({ origin, data: 'relay:close' }, origin)).toBe(true)
  expect(isCloseMessage({ origin: 'https://evil.example', data: 'relay:close' }, origin)).toBe(
    false,
  )
  expect(isCloseMessage({ origin, data: { type: 'relay:close' } }, origin)).toBe(false)
  expect(isCloseMessage({ origin, data: 'relay:open' }, origin)).toBe(false)
})

it('reads the look, falling back to the default', () => {
  expect(readLook({ primaryColor: '#0f766e', open: true })).toEqual({
    primaryColor: '#0f766e',
    open: true,
  })
  expect(readLook({ open: false })).toEqual({ primaryColor: DEFAULT_LOOK.primaryColor, open: false })
  expect(readLook({ primaryColor: 'red; background: url(x)' })).toEqual(DEFAULT_LOOK)
  expect(readLook(null)).toEqual(DEFAULT_LOOK)
})
```

- [ ] **Step 2: Run them to check they fail**

Run: `npx vitest run src/widget`
Expected: FAIL, "Cannot find module './widget-logic'".

- [ ] **Step 3: The logic**

Create `src/widget/widget-logic.ts`:

```ts
import { contrastRatio } from '../features/branding/color'
import { CLOSE_MESSAGE } from '../lib/framing'

// The parts of the booking button (widget.ts) that need no page, kept apart so they can be
// tested. widget.js runs on contractors' own websites: import only files that import nothing
// else (relative paths; the widget build has no '@' alias).

// The script's own address is the contractor's booking page.
export function bookingPageOf(scriptSrc: string): { origin: string; hostname: string } | null {
  try {
    const url = new URL(scriptSrc)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return { origin: url.origin, hostname: url.hostname }
  } catch {
    return null
  }
}

// White or near-black, whichever reads better on the button's color.
export function buttonTextColor(background: string): string {
  return contrastRatio(background, '#ffffff') >= contrastRatio(background, '#111827')
    ? '#ffffff'
    : '#111827'
}

// Only the booking page in the popup may close it, and only with this exact message.
export function isCloseMessage(event: { origin: string; data: unknown }, bookingOrigin: string) {
  return event.origin === bookingOrigin && event.data === CLOSE_MESSAGE
}

// The button's look when the API can't say (offline, an error).
export const DEFAULT_LOOK = { primaryColor: '#1d4ed8', open: true }

// What the API answered; anything unexpected falls back to the default. The color goes into
// CSS, so only a plain hex color is used.
export function readLook(body: unknown): { primaryColor: string; open: boolean } {
  if (typeof body !== 'object' || body === null) return DEFAULT_LOOK
  const { primaryColor, open } = body as Record<string, unknown>
  return {
    primaryColor:
      typeof primaryColor === 'string' && /^#[0-9a-f]{6}$/i.test(primaryColor)
        ? primaryColor
        : DEFAULT_LOOK.primaryColor,
    open: open !== false,
  }
}
```

- [ ] **Step 4: Run them to check they pass**

Run: `npx vitest run src/widget`
Expected: PASS (4 tests).

- [ ] **Step 5: The button and the popup**

Create `src/widget/widget.ts`:

```ts
import { bookingPageOf, buttonTextColor, DEFAULT_LOOK, isCloseMessage, readLook } from './widget-logic'

// The "Book online" button for a contractor's own website. They paste
//   <script src="https://<their booking page>/widget.js" async></script>
// and this adds a floating button that opens the booking wizard in a popup over their page.
// Built on its own as one classic script (vite.config.ts, widgetScript). Everything it draws is
// in a closed shadow root, so the site's CSS can't restyle it and its CSS can't leak out.

declare const __API_URL__: string // VITE_API_URL, set when the script is built

const MARK = '__relayBookingWidget'

const CALENDAR_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/></svg>'

const STYLES = `
  :host { all: initial; }
  .open {
    position: fixed; right: 16px; bottom: calc(16px + env(safe-area-inset-bottom)); z-index: 2147483000;
    display: inline-flex; align-items: center; gap: 8px; padding: 12px 18px; border: 0;
    border-radius: 999px; font: 600 16px/1.2 system-ui, sans-serif; cursor: pointer;
    box-shadow: 0 4px 14px rgb(0 0 0 / 0.25);
  }
  .open svg { width: 20px; height: 20px; }
  .open:focus-visible, .close:focus-visible { outline: 3px solid #111827; outline-offset: 3px; }
  .backdrop {
    position: fixed; inset: 0; z-index: 2147483001; background: rgb(0 0 0 / 0.55);
    display: flex; align-items: center; justify-content: center;
  }
  .backdrop[hidden] { display: none; }
  .panel {
    display: flex; flex-direction: column; width: 100%; height: 100%; background: #fff;
  }
  .bar {
    display: flex; justify-content: flex-end; align-items: center; height: 48px; padding: 0 4px;
    border-bottom: 1px solid #e5e7eb;
  }
  .close {
    width: 40px; height: 40px; border: 0; border-radius: 999px; background: transparent;
    color: #111827; font: 400 28px/1 system-ui, sans-serif; cursor: pointer;
  }
  .panel iframe { flex: 1; width: 100%; border: 0; display: block; }
  @media (min-width: 640px) {
    .panel {
      width: min(480px, 100vw - 32px); height: min(720px, 100vh - 32px);
      border-radius: 16px; overflow: hidden;
    }
  }
`

function start() {
  const script = document.currentScript as HTMLScriptElement | null
  const page = script ? bookingPageOf(script.src) : null
  const marks = window as unknown as Record<string, unknown>
  if (!page || marks[MARK]) return // pasted twice: one button is enough
  marks[MARK] = true

  const lookUrl = new URL(`${__API_URL__}/online-booking/widget`, `${page.origin}/`)
  lookUrl.searchParams.set('host', page.hostname)
  fetch(lookUrl)
    // 404: this address isn't a contractor's booking page. Any other failure: default look.
    .then((res) => (res.ok ? res.json() : res.status === 404 ? { open: false } : DEFAULT_LOOK))
    .catch(() => DEFAULT_LOOK)
    .then((body) => {
      const look = readLook(body)
      if (look.open) whenReady(() => addButton(page.origin, look.primaryColor))
    })
}

function whenReady(run: () => void) {
  if (document.body) run()
  else document.addEventListener('DOMContentLoaded', run, { once: true })
}

function addButton(origin: string, color: string) {
  const host = document.createElement('div')
  host.id = 'relay-booking-widget'
  const root = host.attachShadow({ mode: 'closed' })
  root.innerHTML = `<style>${STYLES}</style>
    <button type="button" class="open">${CALENDAR_ICON}<span>Book online</span></button>
    <div class="backdrop" hidden>
      <div class="panel" role="dialog" aria-modal="true" aria-label="Book a visit">
        <div class="bar"><button type="button" class="close" aria-label="Close">×</button></div>
      </div>
    </div>`
  const open = root.querySelector<HTMLButtonElement>('.open')!
  const backdrop = root.querySelector<HTMLDivElement>('.backdrop')!
  const panel = root.querySelector<HTMLDivElement>('.panel')!
  const close = root.querySelector<HTMLButtonElement>('.close')!
  open.style.background = color
  open.style.color = buttonTextColor(color)

  let frame: HTMLIFrameElement | null = null
  let pageOverflow = ''

  function show() {
    // A new wizard every time: the last one may be on its booked or left screen.
    frame = document.createElement('iframe')
    frame.title = 'Book a visit'
    frame.src = `${origin}/?embed=1&from=widget`
    panel.append(frame)
    backdrop.hidden = false
    pageOverflow = document.documentElement.style.overflow
    document.documentElement.style.overflow = 'hidden' // the page behind doesn't scroll
    close.focus()
  }

  function hide() {
    if (backdrop.hidden) return
    frame?.remove()
    frame = null
    backdrop.hidden = true
    document.documentElement.style.overflow = pageOverflow
    open.focus()
  }

  open.addEventListener('click', show)
  close.addEventListener('click', hide)
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) hide()
  })
  // Escape works while focus is on this page; inside the wizard, its own exit closes it.
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hide()
  })
  window.addEventListener('message', (event) => {
    if (isCloseMessage(event, origin)) hide()
  })
  document.body.append(host)
}

start()
```

- [ ] **Step 6: Build it with Vite**

In `vite.config.ts`, change the `vite` import to
`import { build, defineConfig, loadEnv, type Plugin } from 'vite'`, and add before
`export default`:

```ts
// widget.js: the "Book online" button contractors paste into their own website. It must be one
// classic script with a fixed name (contractors paste its address), so it is built on its own in
// Vite's library mode: fresh on every request in development, added to dist/ by `vite build`.
const widgetEntry = path.resolve(import.meta.dirname, 'src/widget/widget.ts')

async function buildWidget(apiUrl: string): Promise<string> {
  const result = await build({
    configFile: false,
    logLevel: 'warn',
    define: { __API_URL__: JSON.stringify(apiUrl) },
    build: {
      write: false,
      lib: {
        entry: widgetEntry,
        formats: ['iife'],
        name: 'RelayBookingWidget',
        fileName: () => 'widget.js',
      },
    },
  })
  const [output] = Array.isArray(result) ? result : [result]
  return (output as { output: { code: string }[] }).output[0].code
}

function widgetScript(apiUrl: string): Plugin {
  return {
    name: 'relay:widget',
    configureServer(server) {
      server.middlewares.use('/widget.js', (_req, res, next) => {
        buildWidget(apiUrl)
          .then((code) => {
            res.setHeader('Content-Type', 'text/javascript; charset=utf-8')
            res.setHeader('Cache-Control', 'no-cache')
            res.end(code)
          })
          .catch(next)
      })
    },
    async generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'widget.js', source: await buildWidget(apiUrl) })
    },
  }
}
```

Change `export default defineConfig({ ... })` to a function of the mode, so the widget knows the
API address:

```ts
export default defineConfig(({ mode }) => {
  const apiUrl = loadEnv(mode, import.meta.dirname, 'VITE_').VITE_API_URL || '/api'
  return {
    plugins: [
      contractorSite(),
      widgetScript(apiUrl),
      // ...the existing plugins, unchanged
    ],
    // ...the rest of the existing config, unchanged
  }
})
```

and in the `VitePWA({ ... })` options add:

```ts
      // The website button is for other sites; the app's own pages never need it offline.
      workbox: { globIgnores: ['**/node_modules/**/*', 'widget.js'] },
```

- [ ] **Step 7: Check the build and the dev server**

Run (in `relay-web`): `npx vite build` (not `npm run build`: its `tsc -b` stops on the user's
untracked `landing.test.ts`).
Expected: success, and `dist/widget.js` exists. Then:
`grep -cE "^(import|export) " dist/widget.js` → `0`;
`grep -c "online-booking/widget" dist/widget.js` → `1`;
`grep -c "widget.js" dist/sw.js` → `0`.

Run the dev server in the background (`npx vite --port 5199 --strictPort`), then
`curl -s -H "Host: desert.localhost:5199" http://localhost:5199/widget.js | head -c 120`
Expected: JavaScript starting with `var RelayBookingWidget` (or `(function`), not HTML. Stop the
server.

- [ ] **Step 8: Tests, typecheck, lint, commit**

Run: `npx vitest run src/widget src/lib` and `npm run typecheck`
Expected: PASS, apart from the untracked `landing.test.ts`.

```bash
git add src/widget vite.config.ts
git commit -m "feat: widget.js adds a Book online button and popup to a contractor's site

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: "Share your booking page" and the preview (web)

**Files:**
- Create: `relay-web/src/features/settings/copy.ts`, `share-card.tsx`
- Create: `relay-web/src/routes/widget-preview.tsx`
- Modify: `relay-web/src/features/settings/api.ts`, `relay-web/src/routes/settings.tsx`, `relay-web/src/router.tsx`
- Test: `relay-web/src/features/settings/copy.test.ts`

**Interfaces:**
- Consumes: Task 2's `GET /settings/booking-links`; Task 6's `/widget.js`.
- Produces: `useBookingLinks()`, `copyText(text, clipboard?) : Promise<boolean>`, `ShareCard`,
  route `/widget-preview` (owner, office).

- [ ] **Step 1: Write the failing tests**

Create `src/features/settings/copy.test.ts`:

```ts
import { expect, it, vi } from 'vitest'
import { copyText } from './copy'

it('copies the text', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  expect(await copyText('https://desert.relay.app/', { writeText })).toBe(true)
  expect(writeText).toHaveBeenCalledWith('https://desert.relay.app/')
})

it('says when the browser refuses', async () => {
  const writeText = vi.fn().mockRejectedValue(new DOMException('Denied', 'NotAllowedError'))
  expect(await copyText('https://desert.relay.app/', { writeText })).toBe(false)
})
```

- [ ] **Step 2: Run them to check they fail**

Run: `npx vitest run src/features/settings/copy.test.ts`
Expected: FAIL, "Cannot find module './copy'".

- [ ] **Step 3: Copying**

Create `src/features/settings/copy.ts`:

```ts
// Puts `text` on the clipboard. False when the browser refuses (no permission, or not a secure
// page), so the caller can ask the person to copy it themselves.
export async function copyText(
  text: string,
  clipboard: Pick<Clipboard, 'writeText'> | undefined = navigator.clipboard,
): Promise<boolean> {
  if (!clipboard) return false
  try {
    await clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
```

- [ ] **Step 4: Run them to check they pass**

Run: `npx vitest run src/features/settings`
Expected: PASS.

- [ ] **Step 5: The links hook**

Append to `src/features/settings/api.ts`:

```ts
// The contractor's booking page, ready to share.
const BookingLinks = z.object({
  bookingUrl: z.string(),
  googleUrl: z.string(), // the booking link with ?from=google
  widgetSnippet: z.string(), // <script src=".../widget.js" async></script>
})
export type BookingLinks = z.infer<typeof BookingLinks>

export function useBookingLinks() {
  return useQuery({
    queryKey: ['settings', 'booking-links'],
    queryFn: () => api.get('/settings/booking-links', BookingLinks),
  })
}
```

- [ ] **Step 6: The card**

Create `src/features/settings/share-card.tsx` (`cn` is in `@/lib/utils`):

```tsx
import { Check, Copy } from 'lucide-react'
import { type ReactNode, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { errorMessage } from '@/lib/errors'
import { cn } from '@/lib/utils'
import { useBookingLinks } from './api'
import { copyText } from './copy'

// Where homeowners book: the plain link, the link for the contractor's Google Business Profile,
// and the snippet that adds a "Book online" button to their own website.
export function ShareCard() {
  const links = useBookingLinks()

  return (
    <Card>
      <CardHeader>
        <CardTitle>Share your booking page</CardTitle>
        <CardDescription>Send homeowners here to book a visit.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {links.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
        {links.isError && <p className="text-sm text-destructive">{errorMessage(links.error)}</p>}
        {links.data && (
          <>
            <CopyRow label="Your booking link" value={links.data.bookingUrl} />
            <CopyRow
              label="Google Business Profile"
              value={links.data.googleUrl}
              help="In your Google Business Profile, open Edit profile → Booking, and add this as your appointment link."
            />
            <CopyRow
              label="Website button"
              value={links.data.widgetSnippet}
              code
              help={
                <>
                  Paste this just before <code>&lt;/body&gt;</code> on every page of your website.
                  It adds a ‘Book online’ button in your brand colors.{' '}
                  <a
                    className="underline underline-offset-4"
                    href="/widget-preview"
                    target="_blank"
                    rel="noopener"
                  >
                    Preview
                  </a>
                </>
              }
            />
          </>
        )}
      </CardContent>
    </Card>
  )
}

// One thing to copy: the text in a read-only box, and a Copy button. When the browser refuses,
// the text is selected so Ctrl+C copies it.
function CopyRow({
  label,
  value,
  help,
  code = false,
}: {
  label: string
  value: string
  help?: ReactNode
  code?: boolean
}) {
  const [copied, setCopied] = useState(false)
  const box = useRef<HTMLTextAreaElement>(null)

  async function copy() {
    if (await copyText(value)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } else {
      box.current?.select()
      toast('Press Ctrl+C to copy')
    }
  }

  return (
    <div className="space-y-1.5">
      <p className="text-sm font-medium">{label}</p>
      <div className="flex gap-2">
        <textarea
          ref={box}
          readOnly
          value={value}
          rows={code ? 3 : 1}
          aria-label={label}
          onFocus={(event) => event.currentTarget.select()}
          className={cn(
            'min-w-0 flex-1 resize-none rounded-md border bg-muted/40 px-3 py-2 text-sm',
            code && 'font-mono text-xs',
          )}
        />
        <Button type="button" variant="outline" className="shrink-0" onClick={copy}>
          {copied ? <Check /> : <Copy />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      {help && <p className="text-xs text-muted-foreground">{help}</p>}
    </div>
  )
}
```

In `src/routes/settings.tsx`, import `ShareCard` from `@/features/settings/share-card` and
render `<ShareCard />` right after the intro `<p>` (before the loading line), so it shows even
while the other settings load.

- [ ] **Step 7: The preview page**

Create `src/routes/widget-preview.tsx`:

```tsx
import { useEffect } from 'react'

// A plain page with the booking button on it, so the contractor can try the button and its
// popup before handing the snippet to whoever runs their website. Opened in its own tab from
// Booking settings. widget.js comes from this address, which is also their booking page.
export function WidgetPreviewPage() {
  useEffect(() => {
    const script = document.createElement('script')
    script.src = `${location.origin}/widget.js`
    script.async = true
    document.body.append(script) // a second copy (React's dev double run) adds no second button
  }, [])

  return (
    <main className="min-h-svh bg-neutral-200 p-6 text-neutral-600 sm:p-12">
      <div className="mx-auto max-w-2xl space-y-4">
        <h1 className="text-2xl font-semibold text-neutral-800">Your website</h1>
        <p>
          This page stands in for your own website. The “Book online” button in the corner is what
          homeowners will see once the snippet is on your site.
        </p>
        <p>Tap it to open the booking popup. Bookings made here are real visits.</p>
      </div>
    </main>
  )
}
```

In `src/router.tsx`, import `WidgetPreviewPage` from `@/routes/widget-preview` and add, after
the owner/office `StaffLayout` block:

```tsx
      {
        // The booking button on a plain page, outside the sidebar (Booking settings → Preview).
        path: '/widget-preview',
        element: (
          <RequireRole roles={['owner', 'office']}>
            <WidgetPreviewPage />
          </RequireRole>
        ),
      },
```

- [ ] **Step 8: Tests, typecheck, lint, commit**

Run: `npx vitest run src/features src/lib src/widget` and `npm run typecheck`
Expected: PASS, apart from the untracked `landing.test.ts`.

```bash
git add src/features/settings src/routes/settings.tsx src/routes/widget-preview.tsx src/router.tsx
git commit -m "feat: share the booking page from Booking settings, with a button preview

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Check in the browser, with the user

No code. Both apps run on `feat/booking-widget` (`npm run dev` in each; run `npm run db:migrate`
in relay-api first for `0015`).

- [ ] Sign in as the `desert` office user, open **Booking settings**: the card shows the three
  rows; each Copy shows "Copied". (The dev links read `https://desert.localhost/...`, without
  the port: expected on a developer machine, see `tenant-url.ts`.)
- [ ] Click **Preview**: a gray page with the "Book online" button bottom-right in the brand
  color. Tap it: the wizard opens in the popup (centered panel on a computer). ✕, Escape and a
  click on the backdrop close it; focus returns to the button.
- [ ] Book a visit through the popup. "Done" closes it. Open it again: a fresh wizard at step 1.
- [ ] Open the dispatch board: that job's details say "Booked online · from your website".
- [ ] Add `<script src="http://desert.localhost:5173/widget.js" async></script>` before
  `</body>` in `contractor-site/index.html` (temporarily; don't commit), and open
  `http://localhost:5173`: the button shows on the contractor's site (another origin) and the
  popup books. Paste the line twice: still one button.
- [ ] At 375 px wide, the popup fills the screen and the button clears the bottom edge.
- [ ] Open `http://desert.localhost:5173/?from=google` and book: the job says "from Google".
- [ ] In the browser console on `http://localhost:5173`, run
  `document.body.append(Object.assign(document.createElement('iframe'), { src: 'http://desert.localhost:5173/dashboard', width: 600, height: 400 }))`:
  the frame shows "Relay can’t be shown inside another site."
- [ ] Remove the line from `contractor-site/index.html`.
