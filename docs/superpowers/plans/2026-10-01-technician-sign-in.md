# Technician Sign-in Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Technicians sign in on their phone with their mobile number and a 6-digit code texted to it, then land on a technician-only `/jobs` page.

**Architecture:** Two public, rate-limited routes in the accounts module: one saves a hashed code in `sign_in_codes` (table already exists) and texts it through `sendText()`, the other checks the code and starts the same 30-day session office users get. `sendText()` still sends nothing: it stores a placeholder instead of the code and, in development only, logs the text so a developer can read the code. relay-web gets a two-step phone sign-in page, and technician routes that send signed-out visitors to it.

**Tech Stack:** relay-api: Express 5, Drizzle ORM, PostgreSQL 18, Zod, express-rate-limit, Vitest + Supertest. relay-web: React 19, React Router, TanStack Query, Zod, Tailwind v4, shadcn/ui (Base UI), sonner, Vitest.

**Spec:** `relay-api/docs/superpowers/specs/2026-10-01-technician-sign-in-design.md`

## Global Constraints

- Two separate git repos side by side: `relay-api` and `relay-web`. Work on branch `feat/technician-sign-in` in both, made from `main` (the unmerged `feat/booking-photos` work is a separate PR).
- No schema change and no migration: `sign_in_codes`, `users.phone` and the `sign_in_code` message kind already exist.
- Lean, plain code a junior developer can debug without AI. Match the surrounding comment style (short "why" comments above functions).
- Commit messages: lowercase conventional style like the history (`feat: …`, `docs: …`). No `Co-Authored-By` trailer.
- Run Biome only on the files you touched: `npx biome check --write <paths>`. The working copies use CRLF; Biome rewrites touched files to LF, which git normalizes.
- API tests need the local PostgreSQL running (`relay_test` database, see `relay-api/README.md`).
- Numbers: codes are 6 digits, work `10` minutes, `5` tries each, only the newest works; at most `5` codes per phone per hour; `SIGN_IN_CODE_SECRET` at least `32` characters; the existing limiter (`10` per 15 minutes per address) covers both new routes.
- Exact copy:
  - Text: `<Contractor name>: your sign-in code is 123456. It expires in 10 minutes.`
  - Stored text body: `Sign-in code (not stored)`
  - 401: `That code is wrong or has expired. Ask for a new one.`
  - Code field error: `Enter the 6-digit code`; empty phone: `Enter your mobile number`
  - Pages: `Technician sign-in`, `Your jobs`; links `Technician? Sign in with a text code`, `Office staff? Sign in with email`
  - Buttons: `Text me a code` / `Sending…`, `Sign in` / `Signing in…`, `Text me a new code`, `Use a different number`
  - Code step: `If <number> is a technician’s number, we texted it a 6-digit code. It works for 10 minutes.`
  - Resend toast: `New code requested. Only the newest one works.`

## Files

relay-api:
- Modify `src/config/env.ts`, `src/config/env.test.ts`, `vitest.config.ts`, `.env.example`, `README.md`: the `SIGN_IN_CODE_SECRET` setting.
- Modify `src/modules/messaging/sms.ts`: `toUserId`, placeholder body for codes, development log.
- Modify `src/modules/accounts/accounts.{schemas,queries,service,routes}.ts`: the two phone routes.
- Create `src/modules/accounts/phone-sign-in.test.ts`: own file, because the sign-in limiter counts every request a test file makes.
- Modify `docs/real-texting-todo.md`, `README.md`: what Twilio work must keep in mind; how to sign in as a technician locally.

relay-web:
- Create `src/features/auth/next.ts` + `next.test.ts`: `safeNext`, moved out of `sign-in-form.tsx` so both forms use it.
- Modify `src/features/auth/api.ts`: `useSendCode`, `useCodeSignIn`, technicians land on `/jobs`.
- Create `src/features/auth/phone-sign-in-form.tsx`: the two-step form.
- Modify `src/features/auth/require-role.tsx` (`signInPath`), `sign-out-button.tsx` (`to`), `sign-in-form.tsx` (import `safeNext`).
- Create `src/routes/phone-sign-in.tsx`, `src/routes/technician-home.tsx`.
- Modify `src/routes/sign-in.tsx` (link), `src/router.tsx` (routes).

---

### Task 1: Branches, spec and plan

**Files:**
- Commit: `relay-api/docs/superpowers/specs/2026-10-01-technician-sign-in-design.md`, `relay-api/docs/superpowers/plans/2026-10-01-technician-sign-in.md` (untracked in the working copy now)

**Interfaces:**
- Produces: branch `feat/technician-sign-in` in both repos.

- [ ] **Step 1: Branch relay-api from main and commit the docs**

Both working copies are on `feat/booking-photos` with nothing else uncommitted; untracked files move along with the switch.

```bash
cd relay-api
git status --short   # expect only the two docs files, as ??
git switch main
git switch -c feat/technician-sign-in
git add docs/superpowers/specs/2026-10-01-technician-sign-in-design.md docs/superpowers/plans/2026-10-01-technician-sign-in.md
git commit -m "docs: add the technician sign-in spec and plan"
```

- [ ] **Step 2: Branch relay-web from main**

```bash
cd ../relay-web
git status --short   # expect nothing
git switch main
git switch -c feat/technician-sign-in
```

---

### Task 2: API — the secret that keys sign-in codes

**Files:**
- Modify: `relay-api/src/config/env.ts`
- Modify: `relay-api/src/config/env.test.ts`
- Modify: `relay-api/vitest.config.ts`
- Modify: `relay-api/.env.example`, and your local `relay-api/.env` (not committed)
- Modify: `relay-api/README.md`

**Interfaces:**
- Produces: `env.SIGN_IN_CODE_SECRET: string` (32+ characters), set in every environment, tests included.

- [ ] **Step 1: Write the failing tests**

In `src/config/env.test.ts`, add the secret to `required` and add one test at the end:

```ts
const required = {
  DATABASE_URL: 'postgres://relay:relay@localhost:5432/relay',
  APP_DOMAIN: 'localhost',
  SIGN_IN_CODE_SECRET: 'a-secret-that-is-at-least-32-chars-long',
}
```

```ts
it('refuses a sign-in code secret shorter than 32 characters', () => {
  expect(() => parseEnv({ ...required, SIGN_IN_CODE_SECRET: 'short' })).toThrow(
    /SIGN_IN_CODE_SECRET/,
  )
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd relay-api && npx vitest run src/config/env.test.ts`
Expected: FAIL. `fills in defaults` is missing `SIGN_IN_CODE_SECRET` in the parsed result, and the new test doesn't throw.

- [ ] **Step 3: Add the setting**

In `src/config/env.ts`, add to `EnvSchema` after `APP_DOMAIN`:

```ts
  // Keys the hash of technician sign-in codes. Any random string of 32 or more characters.
  SIGN_IN_CODE_SECRET: z.string().min(32),
```

- [ ] **Step 4: Run them to see them pass**

Run: `npx vitest run src/config/env.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Give every environment a value**

`vitest.config.ts`, inside `test.env`, after `APP_DOMAIN`:

```ts
      SIGN_IN_CODE_SECRET: 'test-only-sign-in-code-secret-0123456789',
```

`.env.example`, after the `APP_DOMAIN` line:

```bash
# Keys the hash of technician sign-in codes. This value is for development only; production
# sets its own: node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
SIGN_IN_CODE_SECRET=dev-only-sign-in-code-secret-do-not-use-in-production
```

Append the same `SIGN_IN_CODE_SECRET=…` line to your local `relay-api/.env` (gitignored), or `npm run dev` stops with `Invalid environment variables`.

`README.md`:
- In "If something goes wrong", add a row after the `DATABASE_URL` one:

```markdown
| `Invalid environment variables … at SIGN_IN_CODE_SECRET` when the API starts | Your `.env` is older than technician sign-in: copy the `SIGN_IN_CODE_SECRET` line from `.env.example` into it. |
```

- In the Render "Environment:" line, add `SIGN_IN_CODE_SECRET` after `SENTRY_DSN`, with "(its own random value, made with the command in `.env.example`)".

- [ ] **Step 6: Run everything**

Run: `npm test && npm run typecheck`
Expected: all tests pass, no type errors.

- [ ] **Step 7: Format and commit**

```bash
npx biome check --write src/config/env.ts src/config/env.test.ts vitest.config.ts
git add src/config/env.ts src/config/env.test.ts vitest.config.ts .env.example README.md
git commit -m "feat: add the secret that keys technician sign-in codes"
```

---

### Task 3: API — text a technician a sign-in code

**Files:**
- Modify: `relay-api/src/modules/messaging/sms.ts`
- Modify: `relay-api/src/modules/accounts/accounts.schemas.ts`
- Modify: `relay-api/src/modules/accounts/accounts.queries.ts`
- Modify: `relay-api/src/modules/accounts/accounts.service.ts`
- Modify: `relay-api/src/modules/accounts/accounts.routes.ts`
- Create: `relay-api/src/modules/accounts/phone-sign-in.test.ts`
- Modify: `relay-api/docs/real-texting-todo.md`

**Interfaces:**
- Consumes: `env.SIGN_IN_CODE_SECRET` (Task 2).
- Produces:
  - `sendText(tenantId, { contact, kind, body, toUserId? }, tx?)`
  - `queries.findTechnicianByPhone(phone: string): Promise<{ user: User; tenantId: string; tenantName: string } | undefined>`
  - `accounts.requestSignInCode(phone: string): Promise<void>` (phone in E.164)
  - `accounts.hashCode(code: string): string` (64 hex characters)
  - Zod `PhoneCodeInput = z.object({ phone: UsPhone })` in `accounts.schemas.ts`
  - Route `POST /api/auth/phone/code` → 204
  - Test helpers inside `phone-sign-in.test.ts`: `giveCode(userId, code, values?)`, `typed(phone)`

- [ ] **Step 1: Write the failing tests**

Create `src/modules/accounts/phone-sign-in.test.ts`:

```ts
import { eq } from 'drizzle-orm'
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'
import { createTechnician, createTenant, createUser, resetDb } from '../../../test/helpers.ts'
import { createApp } from '../../app.ts'
import { db } from '../../db/client.ts'
import { messages, signInCodes, users } from '../../db/schema.ts'
import { hashCode, requestSignInCode } from './accounts.service.ts'

// Own file: the sign-in limiter allows 10 requests per 15 minutes and counts every request
// this file makes to /api/auth/phone/*, so most cases call the service directly.
const app = createApp()
const MINUTE_MS = 60 * 1000

beforeEach(resetDb)

// A code saved straight in the database, so the test knows what it is.
async function giveCode(
  userId: string,
  code: string,
  values: Partial<typeof signInCodes.$inferInsert> = {},
) {
  await db.insert(signInCodes).values({
    userId,
    codeHash: hashCode(code),
    expiresAt: new Date(Date.now() + 10 * MINUTE_MS),
    ...values,
  })
}

// '+14805550123' → '(480) 555-0123', the way a technician would type it.
function typed(phone: string) {
  return `(${phone.slice(2, 5)}) ${phone.slice(5, 8)}-${phone.slice(8)}`
}

describe('POST /api/auth/phone/code', () => {
  it('saves a code and a text for the technician, without the code in the text', async () => {
    const tenant = await createTenant('desert')
    const tech = await createTechnician(tenant.id, 'Sam')

    await request(app).post('/api/auth/phone/code').send({ phone: typed(tech.phone!) }).expect(204)

    const codes = await db.select().from(signInCodes)
    expect(codes).toHaveLength(1)
    expect(codes[0]).toMatchObject({ userId: tech.id, attempts: 0, usedAt: null })
    expect(codes[0].codeHash).toMatch(/^[0-9a-f]{64}$/)
    const texts = await db.select().from(messages)
    expect(texts).toHaveLength(1)
    expect(texts[0]).toMatchObject({
      tenantId: tenant.id,
      channel: 'sms',
      direction: 'outbound',
      status: 'queued',
      kind: 'sign_in_code',
      contact: tech.phone,
      toUserId: tech.id,
      body: 'Sign-in code (not stored)',
    })
  })

  it('answers the same for a number nobody uses, and sends nothing', async () => {
    await request(app).post('/api/auth/phone/code').send({ phone: '(480) 555-0000' }).expect(204)

    expect(await db.select().from(signInCodes)).toHaveLength(0)
    expect(await db.select().from(messages)).toHaveLength(0)
  })

  it('rejects a number that is not 10 digits', async () => {
    const res = await request(app).post('/api/auth/phone/code').send({ phone: '555-01' }).expect(400)
    expect(res.body.error.details).toEqual({ phone: ['Enter a 10-digit phone number'] })
  })
})

describe('requestSignInCode', () => {
  it('only texts active technicians', async () => {
    const tenant = await createTenant('desert')
    const gone = await createTechnician(tenant.id, 'Gone')
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, gone.id))
    const office = await createUser('office', tenant.id)
    await db.update(users).set({ phone: '+14805550199' }).where(eq(users.id, office.id))

    await requestSignInCode(gone.phone!)
    await requestSignInCode('+14805550199')

    expect(await db.select().from(signInCodes)).toHaveLength(0)
    expect(await db.select().from(messages)).toHaveLength(0)
  })

  it('texts at most 5 codes an hour to one phone', async () => {
    const tenant = await createTenant('desert')
    const tech = await createTechnician(tenant.id, 'Sam')
    // Over an hour old: deleted, and not counted.
    await giveCode(tech.id, '000000', { createdAt: new Date(Date.now() - 61 * MINUTE_MS) })

    for (let i = 0; i < 6; i++) await requestSignInCode(tech.phone!)

    expect(await db.select().from(signInCodes)).toHaveLength(5)
    expect(await db.select().from(messages)).toHaveLength(5)
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/modules/accounts/phone-sign-in.test.ts`
Expected: FAIL — `accounts.service.ts` has no export named `hashCode` / `requestSignInCode`.

- [ ] **Step 3: Let `sendText()` keep codes out of the database and show texts in development**

Replace `src/modules/messaging/sms.ts` with:

```ts
import { env } from '../../config/env.ts'
import { type Db, db } from '../../db/client.ts'
import { type MESSAGE_KINDS, messages } from '../../db/schema.ts'
import { logger } from '../../lib/logger.ts'

// TEMPORARY: this does not send anything. It saves the text as 'queued' and logs that it did,
// so the rest of the app can be built and tested. Before putting a real provider here, read
// docs/real-texting-todo.md: the consent check, STOP replies and quiet hours all belong in
// this function.
export async function sendText(
  tenantId: string,
  text: {
    contact: string
    kind: (typeof MESSAGE_KINDS)[number]
    body: string
    toUserId?: string // the staff member or technician it goes to
  },
  tx: Db = db,
) {
  // A sign-in code is never stored: anyone who can read messages could sign in with it.
  const body = text.kind === 'sign_in_code' ? 'Sign-in code (not stored)' : text.body
  const [message] = await tx
    .insert(messages)
    .values({ tenantId, channel: 'sms', direction: 'outbound', status: 'queued', ...text, body })
    .returning({ id: messages.id })
  logger.info(
    { tenantId, messageId: message.id, kind: text.kind },
    'Text saved, not sent: real texting isn’t built yet',
  )
  // On a developer's machine the text is printed instead, so you can read a sign-in code.
  if (env.NODE_ENV === 'development') {
    logger.info({ to: text.contact, body: text.body }, 'Development only: the text that would be sent')
  }
}
```

- [ ] **Step 4: Add the input schema**

`src/modules/accounts/accounts.schemas.ts` becomes:

```ts
import { z } from 'zod'
import { UsPhone } from '../../lib/fields.ts'

export const SignInInput = z.object({
  email: z.email().toLowerCase(),
  password: z.string().min(1).max(200),
})

// Technicians type their mobile number in any US format.
export const PhoneCodeInput = z.object({ phone: UsPhone })
```

- [ ] **Step 5: Add the queries**

In `src/modules/accounts/accounts.queries.ts`, change the imports and the top comment, and add four functions at the end:

```ts
import { and, count, eq, isNull, lt } from 'drizzle-orm'
import { db } from '../../db/client.ts'
import { sessions, signInCodes, tenants, type User, users } from '../../db/schema.ts'

// Users, sessions and sign-in codes are looked up before the contractor is known,
// so these queries are not tenant-scoped.
```

```ts
// An active technician with this phone, and their contractor for the sign-in text.
export async function findTechnicianByPhone(phone: string) {
  const [row] = await db
    .select({ user: users, tenantId: tenants.id, tenantName: tenants.name })
    .from(users)
    .innerJoin(tenants, eq(users.tenantId, tenants.id))
    .where(and(eq(users.phone, phone), eq(users.role, 'technician'), isNull(users.disabledAt)))
    .limit(1)
  return row
}

export async function deleteCodesBefore(userId: string, before: Date) {
  await db
    .delete(signInCodes)
    .where(and(eq(signInCodes.userId, userId), lt(signInCodes.createdAt, before)))
}

export async function countCodes(userId: string): Promise<number> {
  const [row] = await db
    .select({ count: count() })
    .from(signInCodes)
    .where(eq(signInCodes.userId, userId))
  return row.count
}

export async function insertCode(values: { userId: string; codeHash: string; expiresAt: Date }) {
  await db.insert(signInCodes).values(values)
}
```

- [ ] **Step 6: Add the service function**

In `src/modules/accounts/accounts.service.ts`, change the imports and constants at the top to:

```ts
import { createHash, createHmac, randomBytes, randomInt, randomUUID } from 'node:crypto'
import { env } from '../../config/env.ts'
import type { User, UserRole } from '../../db/schema.ts'
import { HttpError } from '../../lib/http-error.ts'
import { sendText } from '../messaging/sms.ts'
import * as queries from './accounts.queries.ts'
import { hashPassword, verifyPassword } from './passwords.ts'

const MINUTE_MS = 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const SESSION_DAYS = 30
const RENEW_WHEN_DAYS_LEFT = 15
const CODE_MINUTES = 10
const CODES_PER_HOUR = 5
```

Add after `signIn`:

```ts
// Texts a 6-digit sign-in code to an active technician. An unknown number gets the same
// (empty) answer, so nobody can use this to find out which numbers are technicians'.
export async function requestSignInCode(phone: string) {
  const found = await queries.findTechnicianByPhone(phone)
  if (!found) return

  // At most 5 codes an hour per phone: each text costs money and could pester someone.
  // Codes over an hour old are deleted here, so the table needs no cleanup job.
  await queries.deleteCodesBefore(found.user.id, new Date(Date.now() - 60 * MINUTE_MS))
  if ((await queries.countCodes(found.user.id)) >= CODES_PER_HOUR) return

  const code = randomInt(0, 1_000_000).toString().padStart(6, '0')
  await queries.insertCode({
    userId: found.user.id,
    codeHash: hashCode(code),
    expiresAt: new Date(Date.now() + CODE_MINUTES * MINUTE_MS),
  })
  await sendText(found.tenantId, {
    contact: phone,
    kind: 'sign_in_code',
    body: `${found.tenantName}: your sign-in code is ${code}. It expires in ${CODE_MINUTES} minutes.`,
    toUserId: found.user.id,
  })
}

// Codes are stored as an HMAC keyed with a server secret, so a copy of the database alone
// isn't enough to work out a live code.
export function hashCode(code: string): string {
  return createHmac('sha256', env.SIGN_IN_CODE_SECRET).update(code).digest('hex')
}
```

- [ ] **Step 7: Add the route**

In `src/modules/accounts/accounts.routes.ts`, import `PhoneCodeInput` next to `SignInInput`, put this comment above `const signInLimit`:

```ts
// One limit for every way of signing in: 10 requests per 15 minutes per address, email and
// phone routes counted together.
```

and add after the `/auth/sign-in` route:

```ts
// Technicians: "text me a code". Always 204, whether or not the number is a technician's.
accountsRoutes.post('/auth/phone/code', signInLimit, async (req, res) => {
  const { phone } = PhoneCodeInput.parse(req.body)
  await accounts.requestSignInCode(phone)
  res.status(204).end()
})
```

- [ ] **Step 8: Run the tests to see them pass**

Run: `npx vitest run src/modules/accounts/phone-sign-in.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 9: Note what real texting must keep**

In `docs/real-texting-todo.md`, add to the end of "Must have before sending real texts":

```markdown
- [ ] Technician sign-in codes (`sign_in_code`) and other staff texts go to the contractor's
      own people, not homeowners: the consent check and quiet hours must not block them. Send
      `text.body` to Twilio, but keep storing the placeholder body for `sign_in_code`: the code
      itself must never be saved.
- [ ] Pick the number sign-in codes come from (the contractor's own, or one Relay number for
      everyone) and register a 10DLC campaign that covers one-time passcodes.
- [ ] Decide whether the development-only log of every text in `sendText()` stays. It is how
      developers without Twilio keys read sign-in codes.
```

- [ ] **Step 10: Run everything, format and commit**

```bash
npm test && npm run typecheck
npx biome check --write src/modules/messaging/sms.ts src/modules/accounts/accounts.schemas.ts src/modules/accounts/accounts.queries.ts src/modules/accounts/accounts.service.ts src/modules/accounts/accounts.routes.ts src/modules/accounts/phone-sign-in.test.ts
git add src/modules/messaging/sms.ts src/modules/accounts docs/real-texting-todo.md
git commit -m "feat: text technicians a sign-in code"
```

Expected: all tests pass, no type errors, Biome reports nothing left to fix.

---

### Task 4: API — sign in with the code

**Files:**
- Modify: `relay-api/src/modules/accounts/accounts.schemas.ts`
- Modify: `relay-api/src/modules/accounts/accounts.queries.ts`
- Modify: `relay-api/src/modules/accounts/accounts.service.ts`
- Modify: `relay-api/src/modules/accounts/accounts.routes.ts`
- Modify: `relay-api/src/modules/accounts/phone-sign-in.test.ts`
- Modify: `relay-api/README.md`

**Interfaces:**
- Consumes: `findTechnicianByPhone`, `hashCode`, `giveCode`, `typed` (Task 3).
- Produces:
  - `accounts.signInWithCode(phone: string, typedCode: string): Promise<{ token: string; expiresAt: Date; user: SessionUser }>`; throws `HttpError(401, 'unauthorized', 'That code is wrong or has expired. Ask for a new one.')`
  - Route `POST /api/auth/phone/sign-in` body `{ phone, code }` → `200 { user }` + `relay_session` cookie. relay-web (Task 5) calls it.

- [ ] **Step 1: Write the failing tests**

In `phone-sign-in.test.ts`, import `signInWithCode` too:

```ts
import { hashCode, requestSignInCode, signInWithCode } from './accounts.service.ts'
```

and add at the end of the file:

```ts
const WRONG_CODE = { status: 401, message: 'That code is wrong or has expired. Ask for a new one.' }

describe('POST /api/auth/phone/sign-in', () => {
  it('signs the technician in with the texted code', async () => {
    const tenant = await createTenant('desert')
    const tech = await createTechnician(tenant.id, 'Sam')
    await giveCode(tech.id, '123456')

    const res = await request(app)
      .post('/api/auth/phone/sign-in')
      .send({ phone: typed(tech.phone!), code: '123456' })
      .expect(200)

    expect(res.body.user).toMatchObject({
      id: tech.id,
      role: 'technician',
      tenantId: tenant.id,
      email: null,
    })
    const [cookie] = res.get('Set-Cookie') ?? []
    expect(cookie).toMatch(/^relay_session=[\w-]+;/)
    const me = await request(app).get('/api/auth/me').set('Cookie', cookie.split(';')[0])
    expect(me.body.user.id).toBe(tech.id)
    const [code] = await db.select().from(signInCodes)
    expect(code.usedAt).toBeInstanceOf(Date)
  })

  it('gives the same answer for a wrong code and an unknown number', async () => {
    const tenant = await createTenant('desert')
    const tech = await createTechnician(tenant.id, 'Sam')
    await giveCode(tech.id, '123456')

    const wrongCode = await request(app)
      .post('/api/auth/phone/sign-in')
      .send({ phone: tech.phone, code: '654321' })
      .expect(401)
    const unknownNumber = await request(app)
      .post('/api/auth/phone/sign-in')
      .send({ phone: '+14805550000', code: '123456' })
      .expect(401)

    expect(wrongCode.body).toEqual(unknownNumber.body)
    expect(wrongCode.body.error).toMatchObject({ code: 'unauthorized', message: WRONG_CODE.message })
  })
})

describe('signInWithCode', () => {
  it('accepts a code only once', async () => {
    const tenant = await createTenant('desert')
    const tech = await createTechnician(tenant.id, 'Sam')
    await giveCode(tech.id, '123456')

    await signInWithCode(tech.phone!, '123456')
    await expect(signInWithCode(tech.phone!, '123456')).rejects.toMatchObject(WRONG_CODE)
  })

  it('refuses an expired code', async () => {
    const tenant = await createTenant('desert')
    const tech = await createTechnician(tenant.id, 'Sam')
    await giveCode(tech.id, '123456', { expiresAt: new Date(Date.now() - 1000) })

    await expect(signInWithCode(tech.phone!, '123456')).rejects.toMatchObject(WRONG_CODE)
  })

  it('only accepts the newest code', async () => {
    const tenant = await createTenant('desert')
    const tech = await createTechnician(tenant.id, 'Sam')
    await giveCode(tech.id, '111111', { createdAt: new Date(Date.now() - MINUTE_MS) })
    await giveCode(tech.id, '222222')

    await expect(signInWithCode(tech.phone!, '111111')).rejects.toMatchObject(WRONG_CODE)
    await expect(signInWithCode(tech.phone!, '222222')).resolves.toMatchObject({
      user: { id: tech.id },
    })
  })

  it('stops accepting a code after 5 wrong tries', async () => {
    const tenant = await createTenant('desert')
    const tech = await createTechnician(tenant.id, 'Sam')
    await giveCode(tech.id, '123456')

    for (let i = 0; i < 5; i++) {
      await expect(signInWithCode(tech.phone!, '000000')).rejects.toMatchObject(WRONG_CODE)
    }
    await expect(signInWithCode(tech.phone!, '123456')).rejects.toMatchObject(WRONG_CODE)
  })

  it('refuses a technician taken off the team', async () => {
    const tenant = await createTenant('desert')
    const tech = await createTechnician(tenant.id, 'Sam')
    await giveCode(tech.id, '123456')
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, tech.id))

    await expect(signInWithCode(tech.phone!, '123456')).rejects.toMatchObject(WRONG_CODE)
  })
})
```

This file now makes 6 requests to the limited routes (3 + 3), under the limit of 10.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/modules/accounts/phone-sign-in.test.ts`
Expected: FAIL — no export named `signInWithCode`.

- [ ] **Step 3: Add the input schema**

At the end of `accounts.schemas.ts`:

```ts
export const PhoneSignInInput = z.object({
  phone: UsPhone,
  code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code'),
})
```

- [ ] **Step 4: Add the queries**

In `accounts.queries.ts`, the drizzle import becomes:

```ts
import { and, count, desc, eq, gt, isNull, lt, sql } from 'drizzle-orm'
```

and add at the end:

```ts
// The technician's newest code. Only the last one texted can be used.
export async function findNewestCode(userId: string) {
  const [code] = await db
    .select()
    .from(signInCodes)
    .where(eq(signInCodes.userId, userId))
    .orderBy(desc(signInCodes.createdAt))
    .limit(1)
  return code
}

// Uses up one try on a code that is unused, unexpired and has tries left; false if it has
// none. One UPDATE, so guesses sent at the same moment can't share a try.
export async function spendCodeTry(id: string, maxTries: number, now: Date): Promise<boolean> {
  const spent = await db
    .update(signInCodes)
    .set({ attempts: sql`${signInCodes.attempts} + 1` })
    .where(
      and(
        eq(signInCodes.id, id),
        isNull(signInCodes.usedAt),
        gt(signInCodes.expiresAt, now),
        lt(signInCodes.attempts, maxTries),
      ),
    )
    .returning({ id: signInCodes.id })
  return spent.length > 0
}

// Marks the code used; false if another request used it first.
export async function markCodeUsed(id: string, now: Date): Promise<boolean> {
  const used = await db
    .update(signInCodes)
    .set({ usedAt: now })
    .where(and(eq(signInCodes.id, id), isNull(signInCodes.usedAt)))
    .returning({ id: signInCodes.id })
  return used.length > 0
}
```

- [ ] **Step 5: Add the service function, sharing session start with email sign-in**

In `accounts.service.ts`:

Add `timingSafeEqual` to the `node:crypto` import, and `const CODE_TRIES = 5` after `CODES_PER_HOUR`.

Replace `signIn` with this version, plus the new `startSession` below it:

```ts
export async function signIn(email: string, password: string) {
  const user = await queries.findUserByEmail(email)
  // Check a password even for an unknown email, so both failures take the same time.
  const passwordOk = await verifyPassword(password, user?.passwordHash ?? (await dummyHash()))
  if (!user?.passwordHash || !passwordOk) {
    throw new HttpError(401, 'unauthorized', 'Wrong email or password')
  }
  return startSession(user)
}

async function startSession(user: User) {
  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + SESSION_DAYS * DAY_MS)
  await queries.insertSession({ id: hashToken(token), userId: user.id, expiresAt })
  return { token, expiresAt, user: toSessionUser(user) }
}
```

Add after `hashCode`:

```ts
// Signs a technician in with the code texted to them. Every guess uses up one of the code's
// 5 tries. An unknown number, a wrong code and a used or expired one all get the same answer.
export async function signInWithCode(phone: string, typedCode: string) {
  const found = await queries.findTechnicianByPhone(phone)
  if (!found) throw wrongCode()
  const code = await queries.findNewestCode(found.user.id)
  if (!code) throw wrongCode()

  const now = new Date()
  if (!(await queries.spendCodeTry(code.id, CODE_TRIES, now))) throw wrongCode()
  if (!sameHash(hashCode(typedCode), code.codeHash)) throw wrongCode()
  if (!(await queries.markCodeUsed(code.id, now))) throw wrongCode()
  return startSession(found.user)
}

function wrongCode() {
  return new HttpError(401, 'unauthorized', 'That code is wrong or has expired. Ask for a new one.')
}

// Compares two hex hashes in constant time, so response timing gives nothing away.
function sameHash(a: string, b: string): boolean {
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
}
```

- [ ] **Step 6: Add the route**

In `accounts.routes.ts`, import `PhoneSignInInput` too, and add after the `/auth/phone/code` route:

```ts
accountsRoutes.post('/auth/phone/sign-in', signInLimit, async (req, res) => {
  const { phone, code } = PhoneSignInInput.parse(req.body)
  const session = await accounts.signInWithCode(phone, code)
  setSessionCookie(res, session.token, session.expiresAt)
  res.json({ user: session.user })
})
```

- [ ] **Step 7: Run the tests to see them pass**

Run: `npx vitest run src/modules/accounts/phone-sign-in.test.ts src/modules/accounts/accounts.test.ts`
Expected: PASS (12 + 9 tests). `accounts.test.ts` proves email sign-in still works after the `startSession` change.

- [ ] **Step 8: Tell developers how to sign in as a technician**

In `README.md`, step 6 "Sign in": add a row to the table after `admin@relay.test`:

```markdown
| Sam Patel, Rita Gomez, Luis Moreno | Technicians | `/jobs` (placeholder until the jobs module) |
```

and after the `DEV_PASSWORD` sentence:

```markdown
Technicians have no password. They sign in at **http://desert.localhost:5173/sign-in/phone** with their mobile number: Sam Patel `(480) 555-0301`, Rita Gomez `(480) 555-0302`, Luis Moreno `(480) 555-0303`. Nothing is really texted yet: the code shows up in the `relay-api` terminal, on the line `Development only: the text that would be sent`.
```

- [ ] **Step 9: Run everything, format and commit**

```bash
npm test && npm run typecheck
npx biome check --write src/modules/accounts/accounts.schemas.ts src/modules/accounts/accounts.queries.ts src/modules/accounts/accounts.service.ts src/modules/accounts/accounts.routes.ts src/modules/accounts/phone-sign-in.test.ts
git add src/modules/accounts README.md
git commit -m "feat: let technicians sign in with a texted code"
```

Expected: all tests pass, no type errors.

---

### Task 5: Web — the phone sign-in page and technician routes

**Files:**
- Create: `relay-web/src/features/auth/next.ts`, `relay-web/src/features/auth/next.test.ts`
- Modify: `relay-web/src/features/auth/sign-in-form.tsx`
- Modify: `relay-web/src/features/auth/api.ts`
- Create: `relay-web/src/features/auth/phone-sign-in-form.tsx`
- Modify: `relay-web/src/features/auth/require-role.tsx`
- Modify: `relay-web/src/features/auth/sign-out-button.tsx`
- Create: `relay-web/src/routes/phone-sign-in.tsx`
- Create: `relay-web/src/routes/technician-home.tsx`
- Modify: `relay-web/src/routes/sign-in.tsx`
- Modify: `relay-web/src/router.tsx`

**Interfaces:**
- Consumes: `POST /api/auth/phone/code` `{ phone }` → 204; `POST /api/auth/phone/sign-in` `{ phone, code }` → `{ user }` (Tasks 3–4).
- Produces: routes `/sign-in/phone`, `/jobs`; `safeNext(next: string | null): string | null`; `RequireRole` prop `signInPath?: string`; `SignOutButton` prop `to?: string`.

- [ ] **Step 1: Write the failing test for `safeNext`**

Create `src/features/auth/next.test.ts`:

```ts
import { expect, it } from 'vitest'
import { safeNext } from './next'

it('keeps a path on this site', () => {
  expect(safeNext('/jobs/abc')).toBe('/jobs/abc')
})

it('drops anything that could lead to another site', () => {
  expect(safeNext('//evil.test')).toBeNull()
  expect(safeNext('/\\evil.test')).toBeNull() // browsers read "/\" as "//"
  expect(safeNext('https://evil.test')).toBeNull()
  expect(safeNext(null)).toBeNull()
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd relay-web && npx vitest run src/features/auth/next.test.ts`
Expected: FAIL — `./next` does not exist.

- [ ] **Step 3: Move `safeNext` into its own file**

Create `src/features/auth/next.ts`:

```ts
// Only same-site paths, so a crafted ?next= link can't send people to another site.
export function safeNext(next: string | null): string | null {
  return next?.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : null
}
```

In `src/features/auth/sign-in-form.tsx`, delete the local `safeNext` function and its comment at the bottom, and add the import:

```ts
import { safeNext } from './next'
```

- [ ] **Step 4: Run it to see it pass**

Run: `npx vitest run src/features/auth/next.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Add the API hooks and the technician landing page path**

In `src/features/auth/api.ts`, add after `useSignIn`:

```ts
// Technicians: ask for a code texted to their phone. The API answers the same whether or not
// the number is a technician's.
export function useSendCode() {
  return useMutation({
    mutationFn: (input: { phone: string }) => api.post('/auth/phone/code', input, z.undefined()),
  })
}

export function useCodeSignIn() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { phone: string; code: string }) =>
      api.post('/auth/phone/sign-in', input, z.object({ user: User })),
    onSuccess: ({ user }) => {
      identifyUser(user)
      queryClient.setQueryData(meKey, user)
    },
  })
}
```

and in `homeFor`, the last line becomes:

```ts
  return '/jobs'
```

- [ ] **Step 6: Build the two-step form**

Create `src/features/auth/phone-sign-in-form.tsx`:

```tsx
import { type FormEvent, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { Field, type FieldErrors } from '@/components/form-field'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ApiError } from '@/lib/api'
import { errorMessage } from '@/lib/errors'
import { homeFor, useCodeSignIn, useSendCode } from './api'
import { safeNext } from './next'

// Technicians sign in with their mobile number: they ask for a code, then type the code that
// was texted to them. The code step keeps the number, so a new code is one tap away.
export function PhoneSignInForm() {
  const sendCode = useSendCode()
  const signIn = useCodeSignIn()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [codeSent, setCodeSent] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})

  function onSendCode(event?: FormEvent) {
    event?.preventDefault()
    if (!phone.trim()) {
      setFieldErrors({ phone: ['Enter your mobile number'] })
      return
    }
    setFieldErrors({})
    sendCode.mutate(
      { phone },
      {
        onSuccess: () => {
          if (codeSent) toast.success('New code requested. Only the newest one works.')
          setCodeSent(true)
          setCode('')
          signIn.reset()
        },
        onError: (error) => {
          if (error instanceof ApiError && error.code === 'validation_failed') {
            setFieldErrors(error.details)
          } else {
            toast.error(errorMessage(error))
          }
        },
      },
    )
  }

  function onSignIn(event: FormEvent) {
    event.preventDefault()
    if (!/^\d{6}$/.test(code.trim())) {
      setFieldErrors({ code: ['Enter the 6-digit code'] })
      return
    }
    setFieldErrors({})
    signIn.mutate(
      { phone, code: code.trim() },
      {
        onSuccess: ({ user }) =>
          navigate(safeNext(searchParams.get('next')) ?? homeFor(user.role)),
      },
    )
  }

  if (!codeSent) {
    return (
      <form onSubmit={onSendCode} className="space-y-4" noValidate>
        <Field id="phone" label="Mobile phone" errors={fieldErrors.phone}>
          <Input
            id="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
          />
        </Field>
        <Button type="submit" size="lg" className="w-full" disabled={sendCode.isPending}>
          {sendCode.isPending ? 'Sending…' : 'Text me a code'}
        </Button>
      </form>
    )
  }

  return (
    <form onSubmit={onSignIn} className="space-y-4" noValidate>
      <p className="text-sm text-muted-foreground">
        If {phone.trim()} is a technician’s number, we texted it a 6-digit code. It works for 10
        minutes.
      </p>
      <Field id="code" label="Code" errors={fieldErrors.code}>
        <Input
          id="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          onChange={(event) => setCode(event.target.value)}
        />
      </Field>
      {signIn.error && <p className="text-sm text-destructive">{errorMessage(signIn.error)}</p>}
      <Button type="submit" size="lg" className="w-full" disabled={signIn.isPending}>
        {signIn.isPending ? 'Signing in…' : 'Sign in'}
      </Button>
      <div className="flex flex-wrap justify-between gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={sendCode.isPending}
          onClick={() => onSendCode()}
        >
          Text me a new code
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setCodeSent(false)
            setFieldErrors({})
            signIn.reset()
          }}
        >
          Use a different number
        </Button>
      </div>
    </form>
  )
}
```

- [ ] **Step 7: Let `RequireRole` and `SignOutButton` point technicians to their sign-in page**

`src/features/auth/require-role.tsx`, the function signature and the redirect become:

```tsx
// Shows the page only to the listed roles. Signed-out visitors go to `signInPath` and come back.
export function RequireRole({
  roles,
  signInPath = '/sign-in',
  children,
}: {
  roles: Role[]
  signInPath?: string
  children: ReactNode
}) {
```

```tsx
    return <Navigate to={`${signInPath}?next=${encodeURIComponent(location.pathname)}`} replace />
```

`src/features/auth/sign-out-button.tsx`:

```tsx
export function SignOutButton({ to = '/sign-in' }: { to?: string }) {
```

and in its `onClick`, `navigate('/sign-in')` becomes `navigate(to)`.

- [ ] **Step 8: Add the pages**

Create `src/routes/phone-sign-in.tsx`:

```tsx
import { Link, useLocation } from 'react-router'
import { PageShell } from '@/components/page-shell'
import { Card, CardContent } from '@/components/ui/card'
import { PhoneSignInForm } from '@/features/auth/phone-sign-in-form'

export function PhoneSignInPage() {
  const { search } = useLocation()

  return (
    <PageShell title="Technician sign-in">
      <Card className="max-w-sm">
        <CardContent>
          <PhoneSignInForm />
        </CardContent>
      </Card>
      <p className="text-sm text-muted-foreground">
        Office staff?{' '}
        <Link className="text-primary underline underline-offset-4" to={`/sign-in${search}`}>
          Sign in with email
        </Link>
      </p>
    </PageShell>
  )
}
```

Create `src/routes/technician-home.tsx`:

```tsx
import { PageShell } from '@/components/page-shell'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useMe } from '@/features/auth/api'
import { SignOutButton } from '@/features/auth/sign-out-button'

// Where a technician lands after signing in. Today's jobs arrive with the jobs module.
export function TechnicianHomePage() {
  const me = useMe()

  return (
    <PageShell title="Your jobs" actions={<SignOutButton to="/sign-in/phone" />}>
      <Card>
        <CardHeader>
          <CardTitle>Signed in as {me.data?.name}</CardTitle>
          <CardDescription>Your jobs for today arrive with the jobs module.</CardDescription>
        </CardHeader>
      </Card>
    </PageShell>
  )
}
```

`src/routes/sign-in.tsx` becomes:

```tsx
import { Link, useLocation } from 'react-router'
import { PageShell } from '@/components/page-shell'
import { Card, CardContent } from '@/components/ui/card'
import { SignInForm } from '@/features/auth/sign-in-form'

export function SignInPage() {
  const { search } = useLocation()

  return (
    <PageShell title="Sign in">
      <Card className="max-w-sm">
        <CardContent>
          <SignInForm />
        </CardContent>
      </Card>
      <p className="text-sm text-muted-foreground">
        Technician?{' '}
        <Link className="text-primary underline underline-offset-4" to={`/sign-in/phone${search}`}>
          Sign in with a text code
        </Link>
      </p>
    </PageShell>
  )
}
```

- [ ] **Step 9: Add the routes**

In `src/router.tsx`, change the `react-router` import to:

```tsx
import { createBrowserRouter, Outlet } from 'react-router'
```

import the two new pages:

```tsx
import { PhoneSignInPage } from '@/routes/phone-sign-in'
import { TechnicianHomePage } from '@/routes/technician-home'
```

add after the `/sign-in` route:

```tsx
      { path: '/sign-in/phone', element: <PhoneSignInPage /> },
```

and replace `{ path: '/jobs/:token', element: <JobPage /> },` with:

```tsx
      {
        // Technician screens. Signed-out technicians sign in with a text code, then come back.
        element: (
          <RequireRole roles={['technician']} signInPath="/sign-in/phone">
            <Outlet />
          </RequireRole>
        ),
        children: [
          { path: '/jobs', element: <TechnicianHomePage /> },
          { path: '/jobs/:token', element: <JobPage /> },
        ],
      },
```

- [ ] **Step 10: Check, format and commit**

```bash
npm test && npm run typecheck
npx biome check --write src/features/auth src/routes/phone-sign-in.tsx src/routes/technician-home.tsx src/routes/sign-in.tsx src/router.tsx
git add src/features/auth src/routes/phone-sign-in.tsx src/routes/technician-home.tsx src/routes/sign-in.tsx src/router.tsx
git commit -m "feat: add technician sign-in with a text code"
```

Expected: all tests pass, no type errors.

---

### Task 6: Check it in the running app

**Files:** none in the repos (screenshots go to the session scratchpad).

- [ ] **Step 1: Start both apps**

`npm run dev` in `relay-api` (its `.env` must have `SIGN_IN_CODE_SECRET`, Task 2), then `npm run dev` in `relay-web`. Run `npm run db:seed` in `relay-api` if the demo data is old.

- [ ] **Step 2: Sign in as a technician on a phone-sized window (390 px wide)**

1. Open `http://desert.localhost:5173/jobs/anything`. Expected: redirected to `/sign-in/phone?next=%2Fjobs%2Fanything`.
2. Tap **Text me a code** with the field empty. Expected: `Enter your mobile number`.
3. Type `480 555 0301`, tap **Text me a code**. Expected: the code step, naming the number. The `relay-api` terminal shows `Development only: the text that would be sent` with `Desert Breeze Air: your sign-in code is NNNNNN. It expires in 10 minutes.`
4. Type `000000`. Expected: `That code is wrong or has expired. Ask for a new one.`
5. Type the real code. Expected: lands on `/jobs/anything` (the job page placeholder).
6. Open `/jobs`. Expected: `Your jobs`, `Signed in as Sam Patel`. Tap **Sign out**. Expected: back on `/sign-in/phone`.
7. Sign in again without `?next`. Expected: lands on `/jobs`.
8. On the code step, tap **Text me a new code**. Expected: the toast, a new code in the terminal; the old code no longer works.

- [ ] **Step 3: Check office sign-in still works**

Open `/sign-in`: the `Technician? Sign in with a text code` link is there. Sign in as `office@desert.test` (password `relay-dev-password`). Expected: `/dashboard`. Open `/jobs`. Expected: "No access".

- [ ] **Step 4: Report**

Report the screenshots and anything that didn't match the expected results.
