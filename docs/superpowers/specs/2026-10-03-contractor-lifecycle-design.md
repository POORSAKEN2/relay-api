# Contractor lifecycle: add, list, go live and turn off contractors from the admin page

Date: 2026-10-03. Status: draft. Plan: `docs/superpowers/plans/2026-10-03-contractor-lifecycle.md`.

Sub-project 1 of the white-label admin work. The others, in order: logo and favicon upload,
branding history and revert, branding editor polish (hex input, contrast warning), live
preview. Custom domains, phone numbers and 10DLC, and email from the contractor's domain
come later, once vendors are picked.

## Problem

Contractors exist only in `db:seed`. The superadmin can edit the colors of a contractor that
already exists, but can't add one or turn one off. `tenants.status` (`setup`, `live`,
`suspended`) is stored but nothing reads it, so a suspended contractor would keep working.

## Goal

1. The superadmin adds a contractor and its first owner from the admin page.
2. The owner can sign in right away with a temporary password that the admin sees once.
3. The superadmin moves a contractor between `setup`, `live` and `suspended`.
4. A suspended contractor is fully off: its booking page is unavailable, and its owner,
   office staff and technicians can't sign in. Existing sessions stop working at once.
5. Turning a contractor back on restores everything. Nothing is deleted.
6. The admin page lists contractors with their status and a search box.

## Out of scope

- Forcing the owner to change the temporary password. There is no change-password flow yet;
  it gets its own small spec.
- Emailed invites. They replace the temporary password once email sending (sub-project 8)
  exists.
- Deleting contractors. Turning one off covers it and keeps the history.
- Editing a contractor's details (name, contact, timezone) after creation.
- Contractor stats in the list (technician count, jobs this month).

## Statuses

| Status | Booking page | Staff sign-in | Meaning |
| --- | --- | --- | --- |
| `setup` | works | works | New contractor, being set up. The admin can preview the booking page. |
| `live` | works | works | Taking real bookings. |
| `suspended` | `410` | refused | Turned off. Data kept. |

Every move between the three is allowed. `setup` and `live` behave the same in this
sub-project; later work (texting, billing) can treat them differently.

## API: `modules/tenants` (new)

The routes live in a new `tenants` module. `listTenants` moves there from `modules/branding`.
`modules/branding` keeps the branding routes and `findTenantByHost` / `findTenantById`.
All three routes need `requireRole('superadmin')`.

### `GET /api/admin/tenants`

Same route as today, with more fields. Ordered by name.

```json
{ "tenants": [{ "id": "…", "slug": "desert", "name": "Desert Breeze Air",
  "status": "live", "contactEmail": "office@desert.test",
  "contactPhone": "+16025550142", "createdAt": "2026-10-03T…" }] }
```

### `POST /api/admin/tenants`

Input (zod, `CreateTenantInput`):

| Field | Rule |
| --- | --- |
| `name` | trimmed, 1–100 characters |
| `slug` | `^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$` (lowercased first), not reserved |
| `timezone` | a valid IANA zone (checked with `Intl.supportedValuesOf('timeZone')`) |
| `contactEmail` | email, lowercased |
| `contactPhone` | E.164 |
| `owner.name` | trimmed, 1–100 characters |
| `owner.email` | email, lowercased |

Reserved slugs (`RESERVED_SLUGS`): `www`, `api`, `app`, `admin`, `mail`, `relay`.
These would clash with hostnames Relay uses or will use.

The service, in one transaction:

1. Inserts the tenant with status `setup`.
2. Generates a temporary password: 12 characters from an alphabet without look-alikes
   (no `0 O 1 l I`), using `randomInt`. It's hashed with `hashPassword` like any other.
3. Inserts the owner user (`role: 'owner'`, the new tenant, the password hash).
4. Writes an audit event with `tenantId` set to the new tenant: `tenant.created`, entity `tenant`, data
   `{ slug, ownerUserId }`. The password is never logged or audited.

Response `201`:

```json
{ "tenant": { …same shape as a list item… },
  "owner": { "id": "…", "name": "…", "email": "…", "temporaryPassword": "…" } }
```

The temporary password appears only in this response. The API can't show it again.

Errors:

- `400 validation_error`: bad input, as everywhere (zod details per field).
- `409 conflict`: slug taken (details `{ slug: ['That address is taken'] }`) or owner email
  already used by any user (details `{ 'owner.email': ['That email already has an account'] }`).
  The unique-violation is mapped from the database error with `lib/db-errors.ts`, so a race
  between two creates still gets a clean `409`. Nothing is half-created: it's one transaction.

### `PATCH /api/admin/tenants/:tenantId/status`

Input: `{ status: 'setup' | 'live' | 'suspended' }`. Response `200`: the list-item shape.

In one transaction:

1. Updates `tenants.status`. `404 not_found` if the contractor doesn't exist.
2. If the new status is `suspended`, deletes every session of every user of that tenant.
3. If the status changed, writes `tenant.status_changed`, entity `tenant`, data
   `{ from, to }`. Setting the same status again is a no-op that still returns `200`.

## Enforcement

### Public routes: `tenantFromHost`

After the tenant is found, a `suspended` one throws
`HttpError(410, 'contractor_unavailable', 'This contractor is not taking bookings right now')`.
Every route behind `tenantFromHost` gets this, including `GET /api/branding`, so the web app
learns it on its first request.

The photo route that skips `tenantFromHost` (draft photos by token) is left as is: it serves
nothing without a valid draft token, and the booking page around it is already off.

### Sign-in and sessions: `modules/accounts`

- `signIn` (email): a user whose tenant is suspended gets
  `403 contractor_suspended`, "Your company's account is turned off. Contact Relay support."
  This check runs only after the password is verified, so it doesn't reveal which emails
  exist.
- `requestSignInCode` (phone): a technician of a suspended tenant gets no code (same empty
  answer as an unknown number).
- `signInWithCode`: refused the same way as `signIn`, after the code is checked.
- `findSessionWithUser`: left-joins `tenants` and only returns a row when the user has no
  tenant (superadmin) or the tenant isn't suspended. Like the `disabledAt` check already
  there, this makes suspension hold even if a sign-in races the session delete.

## Web: admin page (`relay-web/src/routes/admin.tsx`)

- **Contractor list.** Replaces the row of buttons: a search box (filters by name or slug,
  on the client) above a list. Each row shows name, `slug.garified.com` and a status badge
  (Setup / Live / Off). Clicking a row selects it, as the buttons do today.
- **Add contractor.** A button opens a dialog with the form above (timezone is a select with
  the US zones first, defaulting to the browser's zone). Field errors from a `400` or `409`
  show under their fields. On success the dialog switches to a "Contractor created" view:
  the sign-in email, the temporary password with a copy button, the booking page address,
  and the warning "This password is shown only once. Send it to the owner now." Closing it
  selects the new contractor.
- **Status control.** In the selected contractor's card header: the badge plus one action.
  `setup` shows "Go live"; `live` shows "Turn off"; `suspended` shows "Turn on" (back to
  `live`). "Turn off" asks for confirmation: "Turn off Desert Breeze Air? Their booking page
  goes offline and their staff are signed out." After any change the list refetches.
- **Booking page when suspended.** On `410 contractor_unavailable` from `GET /api/branding`,
  the booking route shows a plain page "This booking page isn't available right now" with no
  contractor branding.
- **Sign-in page.** Shows the `contractor_suspended` message from the API as is.

## Testing

API (`src/modules/tenants/tenants.test.ts`, plus additions to accounts and branding tests):

- List: shape and order; `401` signed out; `403` for an owner.
- Create: `201` with tenant in `setup`, owner can sign in with the returned password;
  audit row written without the password; `409` for a taken slug and for a taken owner
  email; `400` for a reserved slug and a bad timezone; no tenant left behind after a `409`
  on the owner email.
- Status: each move works; `404` for an unknown contractor; suspending deletes that tenant's
  sessions and not another tenant's; same status is a no-op with no audit row.
- Enforcement: `GET /api/branding` is `410` when suspended; email sign-in `403`; phone code
  not sent; an existing session cookie of that tenant gets `{ user: null }` from
  `/api/auth/me` and `401` from a protected route; turning back on lets them sign in again;
  the superadmin is never affected.

Web (vitest + Testing Library, like the existing branding tests):

- Create dialog: shows field errors from a `409`; shows the password once with a copy
  button.
- Status control: shows the right action per status; "Turn off" needs confirmation.
- Search filters the list.
