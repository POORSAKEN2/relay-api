# Sign-in portals

Each kind of account gets its own sign-in portal: **Contractor** (owner and office staff), **Technician** and **Relay admin**. A portal only lets in its own roles, and the API enforces it.

## Why

Today `/sign-in` is one email form for owners, office staff and the Relay admin, with a small link to the technician text-code form. People can't tell where they belong, and an admin who signs in after a contractor session can land on a contractor's `?next=` page. Separate portals make the entrance obvious and keep each role on its own side.

## Decisions

- Three portals: Contractor (owner + office, email and password), Technician (text code), Relay admin (email and password).
- Signing in at the wrong portal is **refused by the API** and the message points to the right portal.
- `/sign-in` becomes a chooser. Admin is not a card on it, only a small link at the bottom.

## Pages (relay-web)

| URL | Page | Accepts |
|---|---|---|
| `/sign-in` | Portal chooser: a "Contractor" card (owner and office staff, email and password) and a "Technician" card (text code to your phone), plus a small "Relay admin" link | n/a |
| `/sign-in/contractor` | Email form titled "Contractor sign-in" | owner, office |
| `/sign-in/phone` | Text-code form titled "Technician sign-in" (URL unchanged, so old links keep working) | technician |
| `/admin/sign-in` | Email form titled "Relay admin sign-in" | superadmin |

- The chooser's cards and the admin link carry the current `?next=` along.
- Each portal page has a "Not your portal? Choose another" link back to `/sign-in` (keeping `?next=`). It replaces today's "Technician? / Office staff?" cross-links.
- A visitor who is **already signed in** and opens the chooser or any portal goes straight to their landing page (see Landing).
- `RequireRole` already takes `signInPath`. The router sets it per area:
  - owner/office screens and `/widget-preview` → `/sign-in/contractor`
  - `/admin` → `/admin/sign-in`
  - technician screens → `/sign-in/phone` (as today)
- The emailed sign-in link (`/sign-in/link`) is unchanged. It only exists for owner and office invites.

## API (relay-api)

`POST /api/auth/sign-in` takes a required `portal`:

```ts
SignInInput = z.object({
  email: z.email().toLowerCase(),
  password: z.string().min(1).max(200),
  portal: z.enum(['contractor', 'admin']),
})
```

In `accounts.signIn(email, password, portal)`, the order is:

1. Password check, unchanged → `401 unauthorized` "Wrong email or password".
2. Suspended contractor check, unchanged → `403` contractor suspended.
3. **Portal check, new.** If the user's role is not one the portal accepts, throw `HttpError(403, code, message)` and create no session:

| User role | Code | Message |
|---|---|---|
| superadmin | `use_admin_portal` | This is a Relay admin account. Use the admin portal. |
| owner, office | `use_contractor_portal` | This is a contractor account. Use the contractor portal. |
| technician | `use_technician_portal` | This is a technician account. Sign in with a text code. |

The portal check runs after the password check, so a wrong portal never reveals whether an email has an account. A wrong password still gets 401 whatever the portal.

A technician with no password already fails at step 1. The `use_technician_portal` row covers a technician who has one.

`/auth/phone/sign-in` already accepts only technicians, so it is the technician portal and doesn't change. `/auth/link/sign-in` doesn't change.

A missing or unknown `portal` → `400 validation_failed`. Only relay-web calls this route, and it ships in the same change.

## Wrong-portal message (relay-web)

The email form takes a `portal` prop and sends it. When sign-in fails with one of the three `use_*_portal` codes, it shows the API's message and a link to the right portal (`/sign-in/contractor`, `/admin/sign-in` or `/sign-in/phone`), keeping `?next=`. A pure helper `portalPathForError(code)` maps the code to the path, or null for any other error.

## Landing

`landingFor(role, next)` in `features/auth/api.ts`:

- Returns `safeNext(next)` when that path belongs to the role's area, otherwise `homeFor(role)`.
- Areas: superadmin → paths under `/admin`; owner/office → anything that isn't `/admin…`, `/jobs…` or `/j/…`; technician → `/jobs…` and `/j/…`.
- Used by both email forms, the phone form and the "already signed in" redirect.
- This fixes the open task item where an admin signs in after a contractor session and lands on a contractor page. The existing untracked `src/features/auth/landing.test.ts` becomes this function's test.

## Testing

- **relay-api** (`accounts.test.ts`):
  - contractor portal accepts owner and office
  - admin portal accepts superadmin
  - each wrong pairing gets the right `use_*_portal` code and sets no cookie
  - wrong portal plus wrong password → 401
  - missing portal → 400
  - existing tests and `sign-in-limit.test.ts` send `portal`
- **relay-web**: unit tests for `landingFor` (the existing test file plus technician cases) and `portalPathForError`. Typecheck, lint and build pass.
- **Manual**: in the browser, each portal with the seed accounts, the wrong-portal message and link, and the redirect when already signed in.

## Out of scope

- Checking that a contractor account signs in on its own contractor's subdomain.
- Portal-specific branding beyond the contractor theme the app already applies.
- Password reset or sign-up.
