# relay-api

The Relay backend: REST API, Socket.IO, and pg-boss jobs in one Express service. Twilio webhooks and the voice websocket come with the telephony module.

Design and decisions: [docs/superpowers/specs/2026-09-29-foundation-design.md](docs/superpowers/specs/2026-09-29-foundation-design.md)

## Run it on a new computer

This sets up the whole app: relay-api (backend) and relay-web (frontend). It takes about 15 minutes, most of it installing.

### 1. Install the tools (once per computer)

| Tool | Version | Check with |
|---|---|---|
| [Git](https://git-scm.com/downloads) | any recent | `git --version` |
| [Node.js](https://nodejs.org/) | 22.18 or newer (22 LTS or 24 LTS) | `node -v` |
| [PostgreSQL](https://www.postgresql.org/download/) | 18 | pgAdmin opens, or `psql --version` |

- On Windows and macOS, the PostgreSQL installer also installs **pgAdmin**. Write down the password you pick for the `postgres` user, and keep the default port `5432`.
- No local install? Docker works too: `docker run --name relay-postgres -e POSTGRES_PASSWORD=postgres -p 5432:5432 -d postgres:18`
- Use Chrome, Edge or Firefox. They send any `*.localhost` address (such as `desert.localhost`) to your own computer, which the app needs.

### 2. Get the code

Put both repositories side by side in one folder:

```bash
mkdir relay
cd relay
git clone https://github.com/POORSAKEN2/relay-api.git
git clone https://github.com/POORSAKEN2/relay-web.git
```

```
relay/
  relay-api/          backend (this repository)
  relay-web/          frontend
  contractor-site/    optional: the demo contractor's own website, shown on plain localhost:5173
```

### 3. Create the databases (once per computer)

Open pgAdmin, connect to the local server, open the **Query Tool** on the `postgres` database, and run:

```sql
CREATE ROLE relay LOGIN PASSWORD 'relay';
CREATE DATABASE relay OWNER relay;
CREATE DATABASE relay_test OWNER relay;
```

Or with psql (it asks for the `postgres` password from step 1). On Windows, psql is at `C:\Program Files\PostgreSQL\18\bin\psql.exe`.

```bash
psql -h localhost -U postgres -c "CREATE ROLE relay LOGIN PASSWORD 'relay'" -c "CREATE DATABASE relay OWNER relay" -c "CREATE DATABASE relay_test OWNER relay"
```

With the Docker container from step 1, run psql inside it instead:

```bash
docker exec relay-postgres psql -U postgres -c "CREATE ROLE relay LOGIN PASSWORD 'relay'" -c "CREATE DATABASE relay OWNER relay" -c "CREATE DATABASE relay_test OWNER relay"
```

`relay` holds the app's data; `relay_test` is used only by `npm test`. The `relay`/`relay` login is for development only.

### 4. Start the backend

In a terminal:

```bash
cd relay-api
cp .env.example .env
npm install
npm run db:migrate
npm run db:seed
npm run dev
```

- `cp .env.example .env` creates your local settings. The defaults match step 3, so there's nothing to edit.
- `db:migrate` creates the tables; `db:seed` fills them with demo data (see step 6).
- Leave `npm run dev` running. Check http://localhost:3000/health shows `{"ok":true}`.

### 5. Start the frontend

In a second terminal:

```bash
cd relay-web
npm install
npm run dev
```

Leave it running and open **http://desert.localhost:5173/sign-in**. The web app sends `/api` and `/socket.io` to the backend on port 3000, so start the backend first.

### 6. Sign in

The seed creates one contractor, **Desert Breeze Air** (slug `desert`), with 3 technicians, 8 customers and 9 jobs across today and the next working day.

| Account | Role | Lands on |
|---|---|---|
| `owner@desert.test` | Contractor owner | `/dashboard` (dispatch board), `/technicians`, `/services` |
| `office@desert.test` | Office staff | `/dashboard`, `/technicians`, `/services` |
| `admin@relay.test` | Relay superadmin | `/admin` (contractor branding) |
| Sam Patel, Rita Gomez, Luis Moreno | Technicians | `/jobs` (placeholder until the jobs module) |

Every email account uses the same development password: the `DEV_PASSWORD` value in [src/db/seed.ts](src/db/seed.ts).

Technicians have no password. They sign in at **http://desert.localhost:5173/sign-in/phone** with their mobile number: Sam Patel `(480) 555-0301`, Rita Gomez `(480) 555-0302`, Luis Moreno `(480) 555-0303`. With the default `SMS_PROVIDER=log` nothing is really texted: the code shows up in the `relay-api` terminal, on the line `Development only: the text`. To get real texts, see [Real texts with httpSMS](#real-texts-with-httpsms).

Add a phone to a staff member on the Staff screen (`/staff`) to get booking alerts by text. Every new booking texts active owner and office users with a phone; priority bookings send right away, while routine bookings wait until quiet hours end.

Plain http://localhost:5173 (no subdomain) shows the contractor's own website when `../contractor-site` exists; its **Book online** buttons lead to `desert.localhost:5173`.

### 7. Check everything works (optional)

From the `relay` folder:

```bash
cd relay-api
npm test
cd ../relay-web
npm test
```

The API tests run against `relay_test` and set up its tables themselves.

### Everyday use

- **Start work:** `npm run dev` in `relay-api`, then `npm run dev` in `relay-web`.
- **After pulling new code:** run `npm install` in both, and `npm run db:migrate` in `relay-api`.
- **Reset the demo data:** `npm run db:seed` in `relay-api`. It **deletes everything** in the `relay` database first and signs everyone out.

### If something goes wrong

| You see | Fix |
|---|---|
| `Invalid environment variables … at DATABASE_URL` when the API starts | `.env` is missing: run `cp .env.example .env` in `relay-api`. |
| `Invalid environment variables … at SIGN_IN_CODE_SECRET` when the API starts | Your `.env` is older than technician sign-in: copy the `SIGN_IN_CODE_SECRET` line from `.env.example` into it. |
| `password authentication failed for user "relay"` or `database "relay" does not exist` | Step 3 wasn't run on this computer, or PostgreSQL isn't on port 5432. |
| `EADDRINUSE: address already in use :::3000` | Another copy of the API is already running. Stop it (Ctrl+C in its terminal). Keep port 3000: the web app's dev proxy expects it. |
| Vite says port 5173 is in use and picks 5174 | Another web dev server is running. Stop it, or open `desert.localhost:5174` instead. |
| "Contractor not found" | Open `desert.localhost:5173`, not `localhost:5173`, and make sure `npm run db:seed` ran. |
| `desert.localhost` doesn't load | Use Chrome, Edge or Firefox. |
| "Too many sign-in attempts. Try again in 15 minutes." | Sign-in allows 10 tries per 15 minutes. Wait, or restart the API to reset the counter. |
| Signed out after `npm run db:seed` | Expected: seeding clears all sessions. Sign in again. |

## Real texts with httpSMS

The demo sends texts from an Android phone with a Philippine SIM, through [httpSMS](https://httpsms.com). Step-by-step setup, the rules Relay applies, and what to check when a text doesn't arrive: [docs/httpsms-setup.md](docs/httpsms-setup.md).

## Phone calls with Telnyx

Calls to the contractor's number come in through [Telnyx](https://telnyx.com). Account, number, webhook and what to check when a call doesn't come through: [docs/telnyx-setup.md](docs/telnyx-setup.md).

## Real emails with Gmail

Invite emails go through Gmail's SMTP server. Setup and troubleshooting: [docs/gmail-smtp-setup.md](docs/gmail-smtp-setup.md).

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Runs the API with restart on save |
| `npm start` | Runs the API (production) |
| `npm test` | Runs all tests against `relay_test` |
| `npm run typecheck` | Type-checks with `tsc` (Node runs the `.ts` files directly, so there is no build step) |
| `npm run lint` / `npm run format` | Biome lint and format check / fix |
| `npm run db:generate -- --name <change>` | Writes a SQL migration from `src/db/schema.ts` into `drizzle/` |
| `npm run db:migrate` | Applies pending migrations |
| `npm run db:seed` | Resets the development database to demo data |

## How the code is organized

```
src/
  server.ts        starts Express, Socket.IO and pg-boss; shuts down cleanly on SIGTERM
  app.ts           the Express app: middleware, routes, error handler
  instrument.ts    Sentry, loaded first with `node --import`
  config/env.ts    every environment variable, checked with Zod at startup
  middleware/      tenant resolver, sign-in and roles, error handler
  modules/<name>/  one folder per business module: routes, service, queries, schemas, tests
  realtime/        Socket.IO rooms (one per contractor) and event types
  jobs/            pg-boss queues and handlers
  db/              Drizzle client, schema (all tables), migrate and seed scripts
```

Rules:

- **Routes** parse input with Zod (`Schema.parse(req.body)` as the first line), call a service, and send JSON. No SQL, no business rules.
- **Services** hold the business rules and throw `HttpError` for expected failures.
- **Queries** (`*.queries.ts`) are the only place that talks to the database. Every tenant-scoped query takes `tenantId` as its first argument.
- Errors always come back as `{ "error": { "code", "message", "details"?, "requestId"? } }`. Only 5xx errors go to Sentry.
- Imports end in `.ts`, and TypeScript is limited to syntax Node can strip (no enums, no parameter properties).

## Adding a table

1. Sketch it in pgAdmin's ERD Tool and use **Generate SQL**, but don't run it.
2. Port it into `src/db/schema.ts`. Use snake_case names, `id uuid primary key default gen_random_uuid()`, `tenant_id uuid not null references tenants(id)` on business tables, and `timestamptz not null default now()` timestamps.
3. Run `npm run db:generate -- --name <change>`, review the SQL in `drizzle/`, then `npm run db:migrate`. When a change alters existing tables, check the statement order: Drizzle can add a foreign key before the unique constraint it needs, or change a column type under a check that still uses the old type. Fix these by hand, as in `drizzle/0001_mvp_schema.sql`.
4. For SQL Drizzle can't express (functions, triggers), run `npx drizzle-kit generate --custom --name <change>` and fill in the empty file, as in `drizzle/0002_audit_events_append_only.sql`.

## Deploying on Render

Web Service settings:

- Build command: `npm ci`
- Pre-deploy command: `npm run db:migrate`
- Start command: `npm start`
- Health check path: `/health`
- Environment: `NODE_ENV=production`, `DATABASE_URL` (a direct connection, not a pooled one, because pg-boss needs it), `APP_DOMAIN=garified.com`, `SIGN_IN_CODE_SECRET` (its own random value, made with the command in `.env.example`), `SENTRY_DSN`
