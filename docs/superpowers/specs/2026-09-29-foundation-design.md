# Relay foundation — design

- **Date:** 2026-09-29
- **Covers:** `relay-api` and `relay-web`
- **Sources:** "Tech stack and backend architecture", "How a visit gets booked and done", "MVP Scope" (all Sep 29, 2026)

## Goal

Set up both repos so every shared piece of the architecture works end to end, plus one small module (contractor branding) that later modules copy. Business modules (booking, dispatch, jobs, …) are built later, one at a time, on top of this.

Code rules: lean, simple, readable, easy to debug. No stub files and no abstraction without a second use.

## Decisions

| Topic | Decision |
|---|---|
| API contract | **Zod only.** No OpenAPI spec, no generated client. |
| Schema sharing | Each repo owns its Zod schemas. The API validates requests; the web parses the responses it reads. |
| Error tracking | **Sentry** in both repos: 5xx errors, crashes, failed jobs. |
| Sign-in | Sessions stored in Postgres, own code, no auth library. Office users sign in with email + password now; technician SMS codes come with the Twilio work. |
| Database | PostgreSQL + Drizzle ORM. Development uses the local PostgreSQL 18 install. Hosting (Neon or Supabase) is decided later. |
| Schema workflow | Tables are sketched in pgAdmin's ERD Tool, exported as SQL (not run), and ported into `src/db/schema.ts`. `schema.ts` plus generated migrations are the source of truth. |
| Running the API | Node runs `.ts` files directly (type stripping, Node ≥ 22.18). No build step. |
| Validation style | `Schema.parse(req.body)` at the top of each handler. No validate middleware. |
| Tooling | npm, TypeScript strict, Biome (lint + format), Vitest. |

## relay-api

### Layout

```
relay-api/
  src/
    server.ts           http server: Express + Socket.IO + pg-boss, clean shutdown on SIGTERM
    app.ts              builds the Express app (no listen, so tests can import it)
    instrument.ts       Sentry.init, loaded before anything else
    config/env.ts       Zod schema for process.env
    lib/                http-error.ts, logger.ts, origins.ts (CORS allowlist)
    middleware/         tenant.ts, auth.ts, error-handler.ts
    modules/
      accounts/         sign-in, sign-out, me, sessions, passwords
      branding/         branding.routes.ts, .service.ts, .queries.ts, .schemas.ts
    realtime/           Socket.IO server, events.ts, emitToTenant()
    jobs/               pg-boss instance, register(), job handlers
    db/                 client.ts, schema.ts, migrate.ts, seed.ts
    types/express.d.ts  req.tenant and req.user
  test/                 test database setup and helpers
  drizzle/              generated SQL migrations
  docs/                 this spec
```

Tests sit next to the code they cover (`*.test.ts`).

Folders for later work (compliance, adapters, webhooks, voice, the other modules) are created when that work starts.

### Layers

- **Routes** parse input with Zod, call a service, send JSON. No SQL and no business rules.
- **Services** hold business rules and throw `HttpError` for expected failures.
- **Queries** (`*.queries.ts`) are Drizzle only. Every function takes `tenantId` as its first argument, so the contractor filter cannot be forgotten.
- Only `db/` and `*.queries.ts` import Drizzle.

Example handler:

```ts
brandingRoutes.put('/admin/tenants/:tenantId/branding', requireRole('superadmin'), async (req, res) => {
  const { tenantId } = TenantParams.parse(req.params)
  const input = BrandingInput.parse(req.body)
  res.json(await branding.updateBranding(tenantId, input, req.user!.id))
})
```

### Request pipeline

`pino-http → cors → express.json → routers → 404 → error handler`

- Express 5 forwards rejected promises to the error handler, so routes need no try/catch or async wrappers.
- Sentry captures errors where they are thrown (see Sentry below); there is no Sentry middleware.
- `trust proxy` is on in production (Render sits behind a proxy).

### Routes

| Method and path | Access | Purpose |
|---|---|---|
| `GET /health` | public | Render health check, returns `{ ok: true }` |
| `POST /api/auth/sign-in` | public, rate limited | email + password, sets the session cookie |
| `POST /api/auth/sign-out` | public | deletes the session if there is one, clears the cookie, returns 204 |
| `GET /api/auth/me` | public | `{ user: { id, name, email, role, tenantId } \| null }` |
| `GET /api/branding` | public, tenant from host | current branding of the contractor |
| `GET /api/admin/tenants` | superadmin | list of contractors (`id`, `slug`, `name`) |
| `GET /api/admin/tenants/:tenantId/branding` | superadmin | a contractor's current branding (fills the admin form) |
| `PUT /api/admin/tenants/:tenantId/branding` | superadmin | save new colors as a new branding version |
| `/socket.io` | signed in | realtime updates |

Later: `/webhooks/*` (Twilio, Xendit), `/voice` (ConversationRelay websocket).

### Errors

- `HttpError(status, code, message)` in `lib/http-error.ts`.
- The error handler maps:
  - `ZodError` → 400 `validation_failed`; `details` maps each dotted field path to its messages, for example `{ "address.zip": ["Invalid ZIP code"] }`
  - `HttpError` → its own status and code
  - Express's own 4xx errors (malformed JSON, body too large) → that status, `bad_request`
  - anything else → 500 `internal`, with the `requestId`
- One response shape everywhere:

```json
{ "error": { "code": "validation_failed", "message": "Invalid request", "details": { "primaryColor": ["Expected a hex color like #1d4ed8"] } } }
```

Codes used by the foundation: `validation_failed` (400), `bad_request` (4xx), `unauthorized` (401), `forbidden` (403), `not_found` (404), `rate_limited` (429), `internal` (500).

### Tenants

The tenant comes from exactly one source per kind of route:

| Route kind | Tenant from |
|---|---|
| Public (`/api/branding`, booking later) | `X-Tenant-Host` header, set by the web app to its own hostname |
| Signed in (owner, office, technician) | the user's `tenant_id`, from the session; the header is ignored |
| Admin (superadmin) | `:tenantId` in the URL |
| Twilio webhooks (later) | the called number |

Host rules (`APP_DOMAIN` is `garified.com` in production and `localhost` in development):

- `desert.garified.com` → slug `desert`
- `desert.localhost` → slug `desert`
- any host outside `APP_DOMAIN` → lookup by `tenants.custom_domain`
- no match, the bare `APP_DOMAIN`, or deeper subdomains → 404 `not_found`

`tenantFromHost` middleware sets `req.tenant`.

### Sign-in and roles

- Roles: `owner`, `office`, `technician`, `superadmin`. Superadmin users have no tenant.
- Passwords: `scrypt` from `node:crypto` with OWASP parameters; the parameters and salt are stored with the hash.
- Session token: 32 random bytes, sent only in the cookie. The database stores `sha256(token)` as the session id, so a database leak exposes no usable sessions.
- Cookie `relay_session`: `HttpOnly`, `SameSite=Lax`, `Secure` in production, no `Domain` attribute (host-only on `api.garified.com`). Requests from `desert.garified.com` to `api.garified.com` are same-site, so the browser sends it with `credentials: 'include'`.
- Sessions last 30 days and are extended back to 30 days when fewer than 15 remain.
- Sign-in is rate limited to 10 attempts per 15 minutes per IP (`express-rate-limit`). A wrong email and a wrong password return the same error, and take the same time (an unknown email is checked against a dummy hash).
- `requireRole(...roles)` loads the session and user in one query and sets `req.user = { id, name, email, role, tenantId }`. It returns 401 when signed out and 403 unless the role is listed; superadmin is not a wildcard. It also tags Sentry with the user id and tenant. (A separate `requireAuth` comes when a route accepts any signed-in role.)
- CSRF: `SameSite=Lax` cookie, JSON-only bodies, and a CORS allowlist.
- CORS: origins matching `https://*.${APP_DOMAIN}` with credentials (`http` allowed outside production). Custom domains are added with that feature.

### Realtime

- The Socket.IO handshake reads the same cookie and runs the same session lookup, then joins the socket to the room `tenant:<id>`. Connections without a valid session, or without a tenant, are refused.
- One helper sends events: `emitToTenant(tenantId, event, payload)`. Event names and payloads are typed in `realtime/events.ts`.
- Foundation event: `branding.updated` with `{ tenantId }`. Open dashboards refetch branding when they receive it.

### Data

Foundation tables in `src/db/schema.ts`:

| Table | Columns |
|---|---|
| `tenants` | `id`, `slug` (unique), `name`, `custom_domain` (unique, nullable), `timezone`, `created_at` |
| `branding_versions` | `id`, `tenant_id`, `primary_color`, `accent_color`, `logo_url` (nullable), `favicon_url` (nullable), `created_by` (user id), `created_at` |
| `users` | `id`, `tenant_id` (nullable), `email` (unique, stored lowercase), `name`, `role`, `password_hash` (nullable), `created_at` |
| `sessions` | `id` (sha256 of the token), `user_id`, `expires_at`, `created_at` |

A check constraint on `users` keeps roles and tenants consistent: `tenant_id` is null exactly when `role` is `superadmin`.

Conventions (also for tables sketched in pgAdmin):

- snake_case names
- `id uuid primary key default gen_random_uuid()` (except `sessions.id`)
- every business table has `tenant_id uuid not null references tenants(id)`
- timestamps are `timestamptz not null default now()`
- tables live in the `public` schema; pg-boss owns the `pgboss` schema
- no PostgreSQL 18-only features (the hosted database may run 17)

Branding versions are append-only. The current branding is the newest row for the tenant; a revert copies an older row back in as the newest. A tenant with no rows gets the Relay defaults (primary `#1d4ed8`, accent `#0ea5e9`). Colors are validated as `#rrggbb` on both sides.

Scripts:

- `npm run db:generate` — drizzle-kit writes a SQL migration into `drizzle/`
- `npm run db:migrate` — applies migrations (Render pre-deploy command in production)
- `npm run db:seed` — creates the only demo contractor, Desert Breeze Air (`desert`), with its owner, office user and dispatch demo data, plus a superadmin; development passwords are defined in `db/seed.ts`

Development databases on the local PostgreSQL 18: `relay` for the app, `relay_test` for tests.

### Jobs

- pg-boss runs inside the API process and uses the same database.
- `register(name, handler, { cron? })` creates the queue, attaches the worker, and adds an optional schedule. A handler that throws is reported to Sentry with the tag `job:<name>`, then rethrown so pg-boss retries it.
- Foundation job: `session-cleanup`, daily at 03:00 UTC, deletes expired sessions.
- Shutdown order on SIGTERM: stop the HTTP server, close Socket.IO, `boss.stop()` (waits for running jobs), close the database pool.

### Sentry

- Started with `node --import ./src/instrument.ts src/server.ts`, so Sentry loads before Express and pg (required for ESM).
- Sentry 11's `expressIntegration` captures route errors where they are thrown (its `setupExpressErrorHandler` is deprecated). Its `shouldHandleError` reports 5xx only: `ZodError`s and other 4xx responses are user mistakes, not bugs.
- Also reported: failed jobs, pg-boss `error` events, Socket.IO handler errors, startup crashes.
- Each event carries the user id, tenant, and request id. No emails or other personal data.
- Without `SENTRY_DSN`, Sentry is off. Performance tracing is off to save free-tier quota.

### Logging

- pino writes JSON lines to stdout; `pino-pretty` formats them in development.
- pino-http logs one line per request: method, URL, status, duration, request id.
- The request id is returned in the `X-Request-Id` header, attached to Sentry events, and included in 500 responses.
- `cookie` and `set-cookie` headers are redacted from logs.

### Environment

Checked with Zod in `config/env.ts` at startup; the process exits with a list of every invalid variable. Loaded with Node's `--env-file-if-exists=.env` (no dotenv). Documented in `.env.example`.

| Variable | Required | Example |
|---|---|---|
| `NODE_ENV` | no, default `development` | `production` |
| `PORT` | no, default `3000` | `3000` |
| `DATABASE_URL` | yes | `postgres://relay:relay@localhost:5432/relay` (development only) |
| `APP_DOMAIN` | yes | `garified.com` or `localhost` |
| `SENTRY_DSN` | no | from the Sentry project |
| `LOG_LEVEL` | no, default `info` | `debug` |

Tests read `TEST_DATABASE_URL` and use it as `DATABASE_URL`.

## relay-web

### Layout

```
relay-web/src/
  main.tsx            Sentry first, then QueryClient, then RouterProvider
  router.tsx          every route in one file
  lib/
    env.ts            Zod-checked import.meta.env
    api.ts            the one door to the API
    socket.ts         socket.io-client + useSocketEvent()
    sentry.ts         Sentry.init
    utils.ts          cn() from shadcn
  features/           mirrors the API modules
    auth/             useMe(), sign-in form, sign-out button, RequireRole guard
    branding/         useBranding(), applyBranding(), admin BrandingForm
  routes/
    booking.tsx       /              public shell
    sign-in.tsx       /sign-in
    dashboard.tsx     /dashboard     owner, office: shell with live branding
    job.tsx           /jobs/:token   technician: shell
    admin.tsx         /admin         superadmin: contractor list and color form
    not-found.tsx     *
  components/
    app-layout.tsx    applies branding around every page
    page-shell.tsx    phone-first page frame with the contractor's name
    error-fallback.tsx
    ui/               shadcn (Base UI "nova" preset): button, input, label, card
```

### Libraries

- React 19, Vite, Tailwind CSS v4, shadcn/ui.
- React Router in library mode, all routes in `router.tsx`. No framework mode, no SSR.
- TanStack Query for server state: caching, loading and error states, retries. Socket events call `invalidateQueries`. No Redux or Zustand; UI state stays in components.
- Forms use plain inputs and Zod `safeParse` on submit. react-hook-form is added when the booking intake form needs it.

### `api.ts`

- Base URL from `VITE_API_URL`: `/api` in development (proxied by Vite), `https://api.garified.com/api` in production.
- Every request sends `credentials: 'include'`, `X-Tenant-Host: location.hostname`, and JSON.
- `api.get(path, Schema)` and `api.post / api.put(path, body, Schema)` parse the response with Zod and return typed data.
- A non-2xx response throws `ApiError { status, code, message, requestId }`. A response with the wrong shape throws `ApiShapeError` listing the bad fields.

### Auth

- `useMe()` wraps `GET /api/auth/me`.
- `RequireRole` redirects to `/sign-in?next=…` when signed out and shows "No access" for the wrong role.
- After sign-in: superadmin goes to `/admin`, owner and office go to `/dashboard`.

### Branding

- On start, the app fetches `GET /api/branding` and sets `--primary`, `--brand-accent`, and a readable black or white foreground for each on `<html>`, so all shadcn components follow. (shadcn's own `--accent` is its neutral hover color, so the brand accent gets its own variable, used as `bg-brand-accent`.)
- A 404 (unknown host, for example the admin host or plain `localhost`) falls back to the Relay defaults; the booking page then shows "Contractor not found".
- The `branding.updated` socket event triggers a refetch. The socket connects only on signed-in contractor pages (the dashboard), since the API refuses sockets without a tenant.
- The admin page lists contractors and saves two colors per contractor. Logo upload, the contrast warning, and one-click revert come with the full branding module.

### Sentry

- `@sentry/react` is initialized before render. React 19's root error hooks report crashes, and the router's `errorElement` shows a fallback that offers a reload.
- Reported: crashes, API 5xx, network failures, `ApiShapeError`. Not reported: 4xx.
- After sign-in, events carry the user id and tenant.
- `@sentry/vite-plugin` uploads source maps during `vite build` only when `SENTRY_AUTH_TOKEN` is set.

### PWA

`vite-plugin-pwa` with `registerType: 'autoUpdate'`, so a new deploy replaces the cached app shell. One generic Relay manifest for now; per-contractor names and icons come with the branding module.

### Local development

- Open `http://desert.localhost:5173`. Browsers resolve `*.localhost` to the local machine, so the subdomain-to-contractor lookup works as in production.
- Vite proxies `/api` and `/socket.io` to `http://localhost:3000`, so everything is same-origin in development.

### Environment

| Variable | Required | Example |
|---|---|---|
| `VITE_API_URL` | no, default `/api` | `https://api.garified.com/api` |
| `VITE_SENTRY_DSN` | no | from the Sentry project |
| `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT` | build only, optional | source map upload |

Local overrides go in `.env.local` (git-ignored).

## Tooling and tests

- Both repos: npm, `engines.node >= 22.18`, TypeScript strict, Biome, Vitest.
- Scripts in both: `dev`, `typecheck`, `lint`, `test`. The API adds `start` and `db:*`; the web adds `build` and `preview`.
- API unit tests: host → slug parsing, CORS origins, password hash and verify, env parsing, error handler, job failure reporting.
- API integration tests (supertest against `relay_test`): sign-in, sign-out, `/me`; session renewal, expiry and cleanup; the sign-in rate limit; 401 and 403 checks; branding read and update; branding for one contractor never returns another contractor's data; Socket.IO refuses sockets without a tenant and delivers events only to the contractor's own room.
- Web tests: `api.ts` error and shape handling, and the readable text color for brand colors. Pages are checked by hand in the browser.

## Deferred

Built later, each when its module starts: compliance gate, adapters (LLM, payments, email, SMS), Twilio and Xendit webhooks (signature checks, event-id dedupe), voice websocket, the other 8 modules, technician SMS-code sign-in, file storage and logo upload, custom domains, per-contractor PWA manifest, Postgres row-level security, CI, `render.yaml`.
