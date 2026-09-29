# Contractor from the URL path, not the subdomain — design

- **Date:** 2026-09-29
- **Covers:** `relay-api`, `relay-web`, `contractor-site`
- **Changes:** the "Tenants" rules in [2026-09-29-foundation-design.md](2026-09-29-foundation-design.md). Everything else in that design stays.

## Goal

Drop subdomains (`desert.garified.com`, `desert.localhost:5173`) as the way public pages pick their contractor. The web app runs on one origin, and a public page names its contractor in the path: `/book/desert`.

Why:

- One web origin in production: no wildcard DNS or wildcard TLS certificate, and CORS allows exactly one origin.
- Development runs on plain `http://localhost:5173`, which in development also shows the demo contractor's own site (`contractor-site`).
- Booking links read the same everywhere: `<web origin>/book/<slug>`.

## Decisions

| Topic | Decision |
|---|---|
| What picks the contractor on public pages | The slug in the path. Custom domains (`book.desertbreezeair.com`) stay planned; they come later as a host → slug lookup in front of the same routes. |
| Public page URLs | Under a fixed prefix: `/book/:slug` (and `/book/:slug/...` later). App pages (`/sign-in`, `/dashboard`, `/jobs`, `/admin`) can never collide with a slug, so no reserved-slug list is needed. |
| How the API gets the slug | In the API path: `GET /api/book/:slug/branding`, later `/api/book/:slug/services`, `/windows`, and so on. No tenant header. |

## relay-api

### Routes

| Method and path | Access | Change |
|---|---|---|
| `GET /api/book/:slug/branding` | public | **new**, replaces the host-based public read |
| `GET /api/branding` | owner, office, technician | **changed**: now the signed-in user's own contractor, from the session. 401 signed out, 403 for superadmin (no contractor) |
| everything else | | unchanged |

### Tenants

The tenant comes from exactly one source per kind of route:

| Route kind | Tenant from |
|---|---|
| Public (`/api/book/:slug/...`) | `:slug` in the URL |
| Signed in (owner, office, technician) | the user's `tenant_id`, from the session |
| Admin (superadmin) | `:tenantId` in the URL |
| Twilio webhooks (later) | the called number |
| Custom domains (later) | the host, looked up to a slug, then the public routes above |

Slug rules, in `parseSlug(raw)` (`middleware/tenant.ts`):

- trimmed and lowercased, so `/book/Desert` works
- must match `^[a-z0-9-]+$`, otherwise it is not a slug
- a non-slug or an unknown slug gives 404 `not_found` "Contractor not found" (not 400: to a visitor, a bad link and an unknown contractor are the same thing)

`tenantFromHost` becomes `tenantFromSlug`: it reads `req.params.slug`, runs `parseSlug`, looks the tenant up with `findTenantBySlug(slug)` (replacing `findTenantByHost` and its `TenantHost` type), and sets `req.tenant`. The `tenants.custom_domain` column stays for the custom-domain feature.

### CORS and environment

- `APP_DOMAIN` is replaced by `WEB_ORIGIN`, the web app's origin: `http://localhost:5173` in development, the production web URL (for example `https://garified.com`) on Render. Checked as a URL at startup.
- `isAllowedOrigin(origin, webOrigin)` allows exactly that origin (protocol, host and port). Everything else, subdomains included, is refused. The `production` flag goes away: the configured origin already says `http` or `https`. Custom domains add their origins when that feature comes.
- Socket.IO uses the same check, so nothing changes there.
- The session cookie is unchanged. The web origin and `api.<domain>` are still same-site, so the host-only `SameSite=Lax` cookie keeps working with `credentials: 'include'`.
- Existing local `.env` files must swap `APP_DOMAIN=localhost` for `WEB_ORIGIN=http://localhost:5173`, or the API refuses to start (with a message naming `WEB_ORIGIN`).

## relay-web

### Pages

| Path | Page | Change |
|---|---|---|
| `/` | redirect | **changed**: signed in → the role's home, signed out → `/sign-in` |
| `/book/:slug` | booking page | **moved** from `/` |
| `/sign-in` | sign-in | unchanged |
| `/dashboard` | owner, office | unchanged |
| `/jobs` | technician | **new** placeholder: "today's jobs arrive with the jobs module" |
| `/jobs/:token` | job page | unchanged |
| `/admin` | superadmin | shows each contractor's booking link (`<origin>/book/<slug>`) instead of `<slug>.garified.com` |

Homes after sign-in: superadmin → `/admin`, owner and office → `/dashboard`, technician → `/jobs` (was `/`, which would now loop through the redirect). `homeFor(role)` and a new `homePath(user)` (signed out → `/sign-in`) move to `features/auth/home.ts`, a plain module so they can be unit tested.

### Branding

`useBranding()` keeps its name and callers (`AppLayout`, `PageShell`, the booking page), and picks its source from the page on screen:

- on `/book/:slug/*` (found with `useMatch`): `GET /api/book/:slug/branding`, query key `['branding', 'book', slug]`
- anywhere else, when the signed-in user has a contractor: `GET /api/branding`, query key `['branding', 'own', tenantId]` (the tenant id in the key means a different user signing in on the same tab never sees the previous contractor's colors)
- otherwise (signed out, superadmin): no data, so the Relay defaults apply

The dashboard's `branding.updated` refetch and the admin form's refetch keep invalidating the `['branding']` prefix, which covers both.

**Change from the chat design:** the chat said two layouts (public and app). One layout plus this route-aware hook gives the same behavior with less code, and `PageShell` needs no change, so this design uses that.

### `api.ts`

The `X-Tenant-Host` header is removed. Requests send `credentials: 'include'` and JSON, as before.

### Development server

The dev-only Vite plugin in `vite.config.ts` keeps serving `../contractor-site` at `/`, now for any host (there are no subdomains left to tell apart). Paths the site doesn't have (`/book/...`, `/sign-in`, `/src/...`) still reach the app. So in development `/` is the contractor site, while a production build redirects `/` as in the table above.

## contractor-site

- Every **Book online** link becomes `http://localhost:5173/book/desert`.
- README and PRODUCT.md: the booking URL and run instructions follow.

## What changes for people

- Homeowners book at `/book/<slug>` instead of on a subdomain. No subdomain links were ever given out, so no redirects are needed.
- A signed-out technician opening a job link sees Relay's default colors until they sign in (before, the subdomain carried the contractor's colors). The jobs module can return branding with the job when it lands.
- The MVP scope PDF still says a contractor gets "a subdomain"; that line needs updating by hand to "a booking link (`/book/<slug>`)".

## Tests

relay-api:

- `tenant.test.ts`: `parseSlug` on `desert`, `DESERT`, ` desert `, `desert-breeze`, and the rejects: empty, `a.b`, `desert/x`, `desert space`, `ünïcode`.
- `branding.test.ts`:
  - `GET /api/book/:slug/branding`: defaults for a contractor without branding; 404 for an unknown slug and for a non-slug; `DESERT` finds `desert`; each contractor gets only its own branding.
  - `GET /api/branding`: owner, office and technician each get their own contractor's branding (never another's); 401 signed out; 403 superadmin.
  - The PUT test reads the current branding back through the slug route.
- `origins.test.ts`: the exact origin is allowed; a trailing slash in `WEB_ORIGIN` still matches; refused: other sites, look-alikes (`https://garified.com.evil.com`), a subdomain of the web origin, another port, `http` when the origin is `https`, not-a-URL.
- `env.test.ts` and `vitest.config.ts`: `WEB_ORIGIN` instead of `APP_DOMAIN`.

relay-web:

- `api.test.ts`: requests no longer carry `X-Tenant-Host`.
- `home.test.ts`: `homeFor` for every role (technician → `/jobs`), and `homePath(null)` → `/sign-in`.

By hand in the browser (relay-api and relay-web running, seed data):

- `localhost:5173` shows the contractor site; its Book online opens `/book/desert` with Desert Breeze's name and default colors.
- `/book/nope` shows "Contractor not found".
- Desert Breeze's owner signs in and lands on `/dashboard` in its colors; a color change in `/admin` shows up there live.
- The superadmin lands on `/admin` in Relay colors and sees `/book/<slug>` links.
- `/` in the app redirects to `/sign-in` when signed out (checked with `vite preview`, where the dev plugin is off).

Both repos: `npm test`, `npm run typecheck`, `npm run lint`.

## Docs to update

- `2026-09-29-foundation-design.md`: Tenants, the routes table, the cookie example (`desert.garified.com`), the CORS line, the environment table, `api.ts`, Branding, Local development, the route list in the web layout, and the test list. Each change points here.
- relay-api `README.md` (run line, Render environment) and `.env.example`.
- relay-web `README.md` (run section).
- contractor-site `README.md` and `PRODUCT.md`.

## Out of scope

Custom domains (the host → slug lookup and their CORS origins), a Relay marketing page at `/` in production, branding carried by job links, and redirects from old subdomain URLs (none were given out).
