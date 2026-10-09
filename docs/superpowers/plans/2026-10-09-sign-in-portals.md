# Sign-in Portals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give contractor staff, technicians and the Relay admin each their own sign-in portal. Each portal only admits its own roles, enforced by relay-api.

**Architecture:** `POST /api/auth/sign-in` gets a required `portal` (`contractor` | `admin`), checked after the password, and a wrong role gets a `use_*_portal` 403. In relay-web:
- `/sign-in` becomes a chooser.
- New portal pages: `/sign-in/contractor` and `/admin/sign-in`. `/sign-in/phone` stays the technician portal.
- A shared `landingFor(role, next)` decides where everyone lands.

**Tech Stack:** relay-api: Express 5, Zod, Drizzle, Vitest + supertest. relay-web: React 19, React Router, TanStack Query, Zod, Tailwind/shadcn, Vitest (node env, pure-function tests only).

**Spec:** `relay-api/docs/superpowers/specs/2026-10-09-sign-in-portals-design.md`

## Global Constraints

- Both repos work on branch `feat/sign-in-portals` (already created off `main`).
- Commit messages: conventional (`feat:`, `fix:`, `docs:`, `test:`), **no `Co-Authored-By` trailer**.
- Portal check order in `signIn`: password → suspended contractor → portal. A wrong password is always `401 unauthorized` "Wrong email or password".
- Error codes and messages, verbatim:
  - superadmin → `use_admin_portal` "This is a Relay admin account. Use the admin portal."
  - owner/office → `use_contractor_portal` "This is a contractor account. Use the contractor portal."
  - technician → `use_technician_portal` "This is a technician account. Sign in with a text code."
- Portal paths: contractor `/sign-in/contractor`, technician `/sign-in/phone`, admin `/admin/sign-in`, chooser `/sign-in`.
- `?next=` is always passed through `safeNext` and carried across chooser and portal links.
- Each task must pass its repo's `npm test`, `npm run typecheck` and `npm run lint` before committing.

## Review Focus

1. `?next=` carrying a query string or hash (e.g. `/admin?tab=x`, `/jobs/1#notes`) still counts as that area → `landingFor` matches on the path prefix followed by `/`, `?`, `#` or the end (Task 2 test).
2. Look-alike paths (`/administrator`, `/jobsite`) do not count as admin or technician areas (Task 2 test).
3. `?next=` pointing at a sign-in page (`/sign-in/contractor`) is ignored, so nobody bounces back onto a portal after signing in (Task 2 test).
4. A wrong password at the wrong portal still answers 401, never a `use_*_portal` code, so the portal check can't be used to probe which emails exist (Task 1 test).
5. A wrong-portal refusal sets no session cookie, so the person isn't half signed in (Task 1 test).

---

### Task 1: API enforces the portal on email sign-in (relay-api)

**Files:**
- Modify: `relay-api/src/modules/accounts/accounts.schemas.ts` (`SignInInput`)
- Modify: `relay-api/src/modules/accounts/accounts.service.ts` (`signIn`, new `checkPortal`)
- Modify: `relay-api/src/modules/accounts/accounts.routes.ts` (`/auth/sign-in` handler)
- Test: `relay-api/src/modules/accounts/accounts.test.ts`, `relay-api/src/modules/accounts/sign-in-limit.test.ts`

**Interfaces:**
- Produces: request body `{ email, password, portal: 'contractor' | 'admin' }`, and 403 error codes `use_admin_portal`, `use_contractor_portal` and `use_technician_portal` (relay-web Task 3 reads them).
- Produces: `export type Portal = 'contractor' | 'admin'` from `accounts.schemas.ts`, and `signIn(email: string, password: string, portal: Portal)`.

- [ ] **Step 1: Update existing tests to send `portal`, and add the failing tests**

In `accounts.test.ts`, inside `describe('POST /api/auth/sign-in', …)`:
- Change the three existing `.send({ email…, password… })` calls to also send `portal: 'contractor'`.
- Change the malformed-body expectation to `['email', 'password', 'portal']`.
- Add these tests at the end of the describe block:

```ts
  it('lets owners and office staff in through the contractor portal', async () => {
    const tenant = await createTenant('desert')
    for (const role of ['owner', 'office'] as const) {
      const user = await createUser(role, tenant.id)
      await request(app)
        .post('/api/auth/sign-in')
        .send({ email: user.email, password: PASSWORD, portal: 'contractor' })
        .expect(200)
    }
  })

  it('lets the Relay admin in through the admin portal', async () => {
    const admin = await createUser('superadmin', null)
    const res = await request(app)
      .post('/api/auth/sign-in')
      .send({ email: admin.email, password: PASSWORD, portal: 'admin' })
      .expect(200)
    expect(res.body.user.role).toBe('superadmin')
  })

  it.each([
    ['superadmin', 'contractor', 'use_admin_portal', 'This is a Relay admin account. Use the admin portal.'],
    ['owner', 'admin', 'use_contractor_portal', 'This is a contractor account. Use the contractor portal.'],
    ['office', 'admin', 'use_contractor_portal', 'This is a contractor account. Use the contractor portal.'],
    ['technician', 'contractor', 'use_technician_portal', 'This is a technician account. Sign in with a text code.'],
    ['technician', 'admin', 'use_technician_portal', 'This is a technician account. Sign in with a text code.'],
  ] as const)('refuses a %s at the %s portal and starts no session', async (role, portal, code, message) => {
    const tenant = await createTenant('desert')
    const user = await createUser(role, role === 'superadmin' ? null : tenant.id)

    const res = await request(app)
      .post('/api/auth/sign-in')
      .send({ email: user.email, password: PASSWORD, portal })
      .expect(403)

    expect(res.body.error).toMatchObject({ code, message })
    expect(res.get('Set-Cookie')).toBeUndefined()
    expect(await db.select().from(sessions).where(eq(sessions.userId, user.id))).toEqual([])
  })

  it('answers a wrong password at the wrong portal with 401, not the portal hint', async () => {
    const admin = await createUser('superadmin', null)
    const res = await request(app)
      .post('/api/auth/sign-in')
      .send({ email: admin.email, password: 'not it', portal: 'contractor' })
      .expect(401)
    expect(res.body.error.code).toBe('unauthorized')
  })

  it('rejects an unknown portal', async () => {
    const res = await request(app)
      .post('/api/auth/sign-in')
      .send({ email: 'a@test.local', password: 'x', portal: 'technician' })
      .expect(400)
    expect(Object.keys(res.body.error.details)).toEqual(['portal'])
  })
```

In `sign-in-limit.test.ts`, change the email `.send(...)` to `{ email: 'nobody@test.local', password: 'wrong', portal: 'contractor' }`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd relay-api && npx vitest run src/modules/accounts`
Expected: FAIL. The new refusal tests get 200 instead of 403. The malformed-body and unknown-portal tests miss the `portal` key.

- [ ] **Step 3: Implement**

`accounts.schemas.ts`:

```ts
export const Portal = z.enum(['contractor', 'admin'])
export type Portal = z.infer<typeof Portal>

export const SignInInput = z.object({
  email: z.email().toLowerCase(),
  password: z.string().min(1).max(200),
  portal: Portal,
})
```

`accounts.service.ts`: add `import type { Portal } from './accounts.schemas.ts'`, then change `signIn`:

```ts
export async function signIn(email: string, password: string, portal: Portal) {
  // ...password check and suspended check unchanged...
  checkPortal(user.role, portal)
  return startSession(user)
}
```

Add next to `contractorSuspended()`:

```ts
// Each portal admits its own roles. Runs after the password check, so a wrong portal never
// reveals whether an email has an account.
function checkPortal(role: UserRole, portal: Portal) {
  if (role === 'superadmin') {
    if (portal !== 'admin') {
      throw new HttpError(403, 'use_admin_portal', 'This is a Relay admin account. Use the admin portal.')
    }
  } else if (role === 'technician') {
    throw new HttpError(403, 'use_technician_portal', 'This is a technician account. Sign in with a text code.')
  } else if (portal !== 'contractor') {
    throw new HttpError(403, 'use_contractor_portal', 'This is a contractor account. Use the contractor portal.')
  }
}
```

`accounts.routes.ts`:

```ts
  const { email, password, portal } = SignInInput.parse(req.body)
  const session = await accounts.signIn(email, password, portal)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd relay-api && npx vitest run src/modules/accounts && npm run typecheck && npm run lint`
Expected: all PASS. If Biome reformats the long `it.each` rows, run `npx biome check --write src/modules/accounts` and re-run.

- [ ] **Step 5: Commit**

```bash
cd relay-api
git add src/modules/accounts
git commit -m "feat: email sign-in only admits the portal's own roles"
```

---

### Task 2: Landing and portal helpers (relay-web)

**Files:**
- Modify: `relay-web/src/features/auth/api.ts` (add `landingFor`)
- Create: `relay-web/src/features/auth/portals.ts`
- Test: `relay-web/src/features/auth/landing.test.ts` (adopt the untracked file and extend it), `relay-web/src/features/auth/portals.test.ts`

**Interfaces:**
- Consumes: `safeNext(next: string | null): string | null` from `./next`, and `homeFor(role: Role): string` and `Role` from `./api`.
- Produces:
  - `landingFor(role: Role, next: string | null): string` in `features/auth/api.ts`
  - `type Portal = 'contractor' | 'admin'` in `features/auth/portals.ts`
  - `PORTAL_PATHS: { contractor: '/sign-in/contractor'; technician: '/sign-in/phone'; admin: '/admin/sign-in' }`
  - `portalPathForError(error: unknown): string | null`
  - `withSearch(path: string, search: string): string`

- [ ] **Step 1: Write the failing tests**

Append to `landing.test.ts` (keep its four existing tests):

```ts
it('sends technicians to /jobs unless ?next is a technician page', () => {
  expect(landingFor('technician', '/jobs/abc')).toBe('/jobs/abc')
  expect(landingFor('technician', '/j/tok')).toBe('/j/tok')
  expect(landingFor('technician', '/dashboard')).toBe('/jobs')
})

it('matches areas on whole path segments, with or without a query or hash', () => {
  expect(landingFor('superadmin', '/admin?tab=billing')).toBe('/admin?tab=billing')
  expect(landingFor('technician', '/jobs/1#notes')).toBe('/jobs/1#notes')
  expect(landingFor('superadmin', '/administrator')).toBe('/admin')
  expect(landingFor('owner', '/jobsite')).toBe('/jobsite')
  expect(landingFor('technician', '/jobsite')).toBe('/jobs')
})

it('never lands anyone back on a sign-in page', () => {
  expect(landingFor('owner', '/sign-in/contractor')).toBe('/dashboard')
  expect(landingFor('superadmin', '/admin/sign-in')).toBe('/admin')
})
```

Create `portals.test.ts`:

```ts
import { expect, it } from 'vitest'
import { ApiError } from '@/lib/api'
import { portalPathForError, withSearch } from './portals'

const refused = (code: string) => new ApiError(403, { code, message: 'x' })

it('points each wrong-portal refusal at the right portal', () => {
  expect(portalPathForError(refused('use_admin_portal'))).toBe('/admin/sign-in')
  expect(portalPathForError(refused('use_contractor_portal'))).toBe('/sign-in/contractor')
  expect(portalPathForError(refused('use_technician_portal'))).toBe('/sign-in/phone')
})

it('has no portal for other failures', () => {
  expect(portalPathForError(refused('unauthorized'))).toBeNull()
  expect(portalPathForError(new Error('boom'))).toBeNull()
})

it('carries the query string along', () => {
  expect(withSearch('/sign-in', '?next=%2Fadmin')).toBe('/sign-in?next=%2Fadmin')
  expect(withSearch('/sign-in', '')).toBe('/sign-in')
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd relay-web && npx vitest run src/features/auth`
Expected: FAIL with "landingFor is not a function" and "Cannot find module './portals'".

- [ ] **Step 3: Implement**

In `features/auth/api.ts`, add `import { safeNext } from './next'` and, below `homeFor`:

```ts
const ADMIN_AREA = /^\/admin(?:[/?#]|$)/
const TECHNICIAN_AREA = /^\/(?:jobs|j)(?:[/?#]|$)/
const SIGN_IN = /^\/(?:sign-in|admin\/sign-in)(?:[/?#]|$)/

// Where someone lands after signing in: ?next= when it is a page their role can open, else
// their home. A contractor's ?next= left in the address bar can't pull the admin elsewhere.
export function landingFor(role: Role, next: string | null): string {
  const path = safeNext(next)
  if (!path || SIGN_IN.test(path)) return homeFor(role)
  const admin = ADMIN_AREA.test(path)
  const technician = TECHNICIAN_AREA.test(path)
  const fits =
    role === 'superadmin' ? admin : role === 'technician' ? technician : !admin && !technician
  return fits ? path : homeFor(role)
}
```

Create `features/auth/portals.ts`:

```ts
import { ApiError } from '@/lib/api'

// The email portals relay-api knows. Technicians sign in by text code, not by email.
export type Portal = 'contractor' | 'admin'

export const PORTAL_PATHS = {
  contractor: '/sign-in/contractor',
  technician: '/sign-in/phone',
  admin: '/admin/sign-in',
} as const

const PORTAL_FOR_CODE: Record<string, string> = {
  use_admin_portal: PORTAL_PATHS.admin,
  use_contractor_portal: PORTAL_PATHS.contractor,
  use_technician_portal: PORTAL_PATHS.technician,
}

// The right portal when relay-api refused a sign-in for coming through the wrong one.
export function portalPathForError(error: unknown): string | null {
  return error instanceof ApiError ? (PORTAL_FOR_CODE[error.code] ?? null) : null
}

// Keeps ?next= when moving between the chooser and the portals.
export function withSearch(path: string, search: string): string {
  return `${path}${search}`
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd relay-web && npx vitest run src/features/auth && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd relay-web
git add src/features/auth/api.ts src/features/auth/portals.ts src/features/auth/portals.test.ts src/features/auth/landing.test.ts
git commit -m "feat: each role lands on its own pages after signing in"
```

---

### Task 3: Sign-in forms speak portals (relay-web)

**Files:**
- Modify: `relay-web/src/features/auth/api.ts` (`SignInInput` adds `portal`)
- Modify: `relay-web/src/features/auth/sign-in-form.tsx`
- Modify: `relay-web/src/features/auth/phone-sign-in-form.tsx`

**Interfaces:**
- Consumes: `landingFor`, `Portal`, `portalPathForError` and `withSearch` from Task 2, and the API error codes from Task 1.
- Produces: `<SignInForm portal={Portal} />` (Task 4 renders it).

No unit test (relay-web tests are node-only, with no DOM). The behavior is covered by Task 2's helpers and Task 5's manual check.

- [ ] **Step 1: Add `portal` to the client input**

In `features/auth/api.ts`:

```ts
export const SignInInput = z.object({
  email: z.email('Enter a valid email'),
  password: z.string().min(1, 'Enter your password'),
  portal: z.enum(['contractor', 'admin']),
})
```

- [ ] **Step 2: Update `SignInForm`**

In `sign-in-form.tsx`:
- Import `Link` and `useLocation` from `react-router`.
- Import `landingFor` (instead of `homeFor`) and `SignInInput` from `./api`.
- Import `type Portal`, `portalPathForError` and `withSearch` from `./portals`.
- Drop the `safeNext` import.

Change the signature and submit:

```tsx
export function SignInForm({ portal }: { portal: Portal }) {
  const signIn = useSignIn()
  const navigate = useNavigate()
  const { search } = useLocation()
  const [searchParams] = useSearchParams()
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const rightPortal = portalPathForError(signIn.error)

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const parsed = SignInInput.safeParse({
      ...Object.fromEntries(new FormData(event.currentTarget)),
      portal,
    })
    // ...unchanged validation...
    signIn.mutate(parsed.data, {
      onSuccess: ({ user }) => navigate(landingFor(user.role, searchParams.get('next'))),
    })
  }
```

Replace the error paragraph with:

```tsx
      {signIn.error && (
        <p className="text-sm text-destructive">
          {signIn.error instanceof ApiError
            ? signIn.error.message
            : 'Could not sign in. Try again.'}
          {rightPortal && (
            <>
              {' '}
              <Link className="underline underline-offset-4" to={withSearch(rightPortal, search)}>
                Go there
              </Link>
            </>
          )}
        </p>
      )}
```

- [ ] **Step 3: Phone form uses `landingFor`**

In `phone-sign-in-form.tsx`:
- Replace `homeFor` with `landingFor` in the `./api` import and drop the `safeNext` import.
- Change `onSuccess` to `({ user }) => navigate(landingFor(user.role, searchParams.get('next')))`.

- [ ] **Step 4: Verify**

Run: `cd relay-web && npm run typecheck && npm test && npm run lint`
Expected: typecheck **fails** only in `src/routes/sign-in.tsx` (missing `portal` prop on `<SignInForm />`). That is fixed in Task 4. Do not commit yet. Go straight to Task 4 and commit both together.

---

### Task 4: Portal pages, chooser and routing (relay-web)

**Files:**
- Create: `relay-web/src/features/auth/redirect-if-signed-in.tsx`
- Create: `relay-web/src/features/auth/portal-switch-link.tsx`
- Create: `relay-web/src/routes/contractor-sign-in.tsx`
- Create: `relay-web/src/routes/admin-sign-in.tsx`
- Modify: `relay-web/src/routes/sign-in.tsx` (becomes the chooser)
- Modify: `relay-web/src/routes/phone-sign-in.tsx`
- Modify: `relay-web/src/router.tsx`
- Modify: `relay-web/README.md` (sign-in instructions)

**Interfaces:**
- Consumes: `SignInForm({ portal })` from Task 3; `landingFor`, `useMe` from `features/auth/api`; `PORTAL_PATHS`, `withSearch` from `features/auth/portals`; `RequireRole`'s existing `signInPath` prop.
- Produces: routes `/sign-in`, `/sign-in/contractor`, `/sign-in/phone`, `/admin/sign-in`.

- [ ] **Step 1: `RedirectIfSignedIn`**

`features/auth/redirect-if-signed-in.tsx`:

```tsx
import type { ReactNode } from 'react'
import { Navigate, useSearchParams } from 'react-router'
import { landingFor, useMe } from './api'

// Sign-in pages: someone already signed in goes straight to their own pages.
export function RedirectIfSignedIn({ children }: { children: ReactNode }) {
  const me = useMe()
  const [searchParams] = useSearchParams()

  if (me.isPending) return null
  if (me.data) return <Navigate to={landingFor(me.data.role, searchParams.get('next'))} replace />
  return children
}
```

If `/auth/me` fails, `me.data` is undefined and the form still shows. That's intended: the person can still try to sign in.

- [ ] **Step 2: `PortalSwitchLink`**

`features/auth/portal-switch-link.tsx`:

```tsx
import { Link, useLocation } from 'react-router'
import { withSearch } from './portals'

export function PortalSwitchLink() {
  const { search } = useLocation()
  return (
    <p className="text-sm text-muted-foreground">
      Not your portal?{' '}
      <Link className="text-primary underline underline-offset-4" to={withSearch('/sign-in', search)}>
        Choose another
      </Link>
    </p>
  )
}
```

- [ ] **Step 3: Portal pages**

`routes/contractor-sign-in.tsx`:

```tsx
import { PageShell } from '@/components/page-shell'
import { Card, CardContent } from '@/components/ui/card'
import { PortalSwitchLink } from '@/features/auth/portal-switch-link'
import { RedirectIfSignedIn } from '@/features/auth/redirect-if-signed-in'
import { SignInForm } from '@/features/auth/sign-in-form'

export function ContractorSignInPage() {
  return (
    <RedirectIfSignedIn>
      <PageShell title="Contractor sign-in">
        <p className="text-muted-foreground">For owners and office staff.</p>
        <Card className="max-w-sm">
          <CardContent>
            <SignInForm portal="contractor" />
          </CardContent>
        </Card>
        <PortalSwitchLink />
      </PageShell>
    </RedirectIfSignedIn>
  )
}
```

`routes/admin-sign-in.tsx` follows the same pattern, written out:

```tsx
import { PageShell } from '@/components/page-shell'
import { Card, CardContent } from '@/components/ui/card'
import { PortalSwitchLink } from '@/features/auth/portal-switch-link'
import { RedirectIfSignedIn } from '@/features/auth/redirect-if-signed-in'
import { SignInForm } from '@/features/auth/sign-in-form'

export function AdminSignInPage() {
  return (
    <RedirectIfSignedIn>
      <PageShell title="Relay admin sign-in">
        <Card className="max-w-sm">
          <CardContent>
            <SignInForm portal="admin" />
          </CardContent>
        </Card>
        <PortalSwitchLink />
      </PageShell>
    </RedirectIfSignedIn>
  )
}
```

`routes/phone-sign-in.tsx` becomes:

```tsx
import { PageShell } from '@/components/page-shell'
import { Card, CardContent } from '@/components/ui/card'
import { PhoneSignInForm } from '@/features/auth/phone-sign-in-form'
import { PortalSwitchLink } from '@/features/auth/portal-switch-link'
import { RedirectIfSignedIn } from '@/features/auth/redirect-if-signed-in'

export function PhoneSignInPage() {
  return (
    <RedirectIfSignedIn>
      <PageShell title="Technician sign-in">
        <Card className="max-w-sm">
          <CardContent>
            <PhoneSignInForm />
          </CardContent>
        </Card>
        <PortalSwitchLink />
      </PageShell>
    </RedirectIfSignedIn>
  )
}
```

- [ ] **Step 4: The chooser**

`routes/sign-in.tsx` becomes:

```tsx
import { ChevronRight } from 'lucide-react'
import { Link, useLocation } from 'react-router'
import { PageShell } from '@/components/page-shell'
import { Card, CardContent } from '@/components/ui/card'
import { PORTAL_PATHS, withSearch } from '@/features/auth/portals'
import { RedirectIfSignedIn } from '@/features/auth/redirect-if-signed-in'

const PORTALS = [
  {
    to: PORTAL_PATHS.contractor,
    title: 'Contractor',
    body: 'Owners and office staff. Sign in with your email and password.',
  },
  {
    to: PORTAL_PATHS.technician,
    title: 'Technician',
    body: 'Sign in with a code texted to your phone.',
  },
]

// Each kind of account has its own portal; this page only points the way.
export function SignInPage() {
  const { search } = useLocation()

  return (
    <RedirectIfSignedIn>
      <PageShell title="Sign in">
        <div className="grid max-w-2xl gap-4 sm:grid-cols-2">
          {PORTALS.map((portal) => (
            <Link key={portal.to} to={withSearch(portal.to, search)} className="group">
              <Card className="h-full transition-colors group-hover:border-primary">
                <CardContent className="flex items-start justify-between gap-3">
                  <div className="space-y-1">
                    <h2 className="font-semibold">{portal.title}</h2>
                    <p className="text-sm text-muted-foreground">{portal.body}</p>
                  </div>
                  <ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground" />
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
        <p className="text-sm text-muted-foreground">
          <Link className="underline underline-offset-4" to={withSearch(PORTAL_PATHS.admin, search)}>
            Relay admin
          </Link>
        </p>
      </PageShell>
    </RedirectIfSignedIn>
  )
}
```

Check that `lucide-react` is a dependency (`grep lucide-react relay-web/package.json`). shadcn projects include it. If it's missing, drop the icon rather than adding a dependency.

- [ ] **Step 5: Router**

In `router.tsx`:
- Import `ContractorSignInPage` and `AdminSignInPage`.
- Add `{ path: '/sign-in/contractor', element: <ContractorSignInPage /> }` after `/sign-in`.
- Add `{ path: '/admin/sign-in', element: <AdminSignInPage /> }` **before** the `/admin` route.
- Pass `signInPath="/sign-in/contractor"` to both owner/office `RequireRole` wrappers (the `StaffLayout` one and the `/widget-preview` one). The inner `/analytics` one is nested inside a signed-in area and needs none.
- Pass `signInPath="/admin/sign-in"` to the `/admin` `RequireRole`.

- [ ] **Step 6: README**

In `relay-web/README.md`, "Run it on a new computer" step 2, replace the sign-in sentence with:

> 2. Open **http://desert.localhost:5173/sign-in** and pick a portal. **Contractor** (`owner@desert.test` or `office@desert.test`) reaches the dispatch board (`/dashboard`), `/technicians` and `/services`. **Technician** signs in with a text code. The **Relay admin** link (`admin@relay.test`, or go straight to `/admin/sign-in`) opens `/admin`. Each portal only accepts its own accounts. The development password is the `DEV_PASSWORD` value in relay-api's `src/db/seed.ts`.

- [ ] **Step 7: Verify**

Run: `cd relay-web && npm run typecheck && npm test && npm run lint && npm run build`
Expected: all PASS.

- [ ] **Step 8: Commit (Tasks 3 and 4 together)**

```bash
cd relay-web
git add src/features/auth src/routes src/router.tsx README.md
git commit -m "feat: separate sign-in portals for contractors, technicians and the Relay admin"
```

---

### Task 5: Manual check in the browser

Run relay-api (`npm run dev`, port 3000) and relay-web (`npm run dev`). Use the seed accounts.

- [ ] `http://desert.localhost:5173/sign-in` shows the Contractor and Technician cards plus the Relay admin link.
- [ ] Contractor portal + `owner@desert.test` → `/dashboard`.
- [ ] Contractor portal + `admin@relay.test` → "This is a Relay admin account. Use the admin portal." with **Go there** → `/admin/sign-in`, and the person is not signed in.
- [ ] Admin portal + `owner@desert.test` → the contractor-portal message and link.
- [ ] Admin portal + `admin@relay.test` → `/admin`.
- [ ] Signed out, open `/admin` → redirected to `/admin/sign-in?next=%2Fadmin`. Sign in → `/admin`.
- [ ] Signed out, open `/customers` → `/sign-in/contractor?next=%2Fcustomers`.
- [ ] Sign in as owner, sign out, sign in at the admin portal with a leftover `?next=/dashboard` → `/admin` (the original task-list bug).
- [ ] While signed in, open `/sign-in` → sent to your home.
- [ ] Phone width (375px): the chooser cards stack and nothing scrolls sideways.

Report anything that differs. Fixes get their own `fix:` commits.
