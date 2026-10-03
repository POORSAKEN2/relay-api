# SMS Service Implementation Plan

**Goal:** Texts really leave Relay through httpSMS (an Android phone with a PH SIM), with the
consent and quiet-hours rules applied, and delivery statuses, replies (STOP / START) and missed
calls coming back through a webhook. PH mobile numbers work everywhere a phone is typed.

**Architecture:** `messages` is the outbox. `sendText()` keeps its signature: in the caller's
transaction it applies the rules (`rules.ts`) and saves the row as `queued` (with `send_after`)
or `blocked`. A sender loop (`sender.ts`, every 5 s, started in `server.ts`) claims due rows
with one `update … for update skip locked` and hands them to httpSMS (`httpsms.ts`), passing our
`messages.id` as `request_id`. Sign-in codes are sent right away by `sendText()` since their body
is never stored. `POST /api/webhooks/httpsms` checks the HS256 JWT with `jose`, ignores repeats
through `webhook_events`, and moves statuses forward only.

**Spec:** `relay-api/docs/superpowers/specs/2026-10-04-sms-service-design.md`
**Schema draft:** `relay-api/docs/superpowers/specs/2026-10-04-sms-service-schema.sql`

## Global Constraints

- Branch `feat/sms-service` in both `relay-api` and `relay-web`.
- Lean, plain code a junior developer can debug without AI. Short "why" comments.
- Commit messages lowercase conventional (`feat: …`). No `Co-Authored-By` trailer.
- Biome only on touched files: `npx biome check --write <paths>`.
- Exact copy: phone error `Enter a mobile number, like 0917 123 4567`; booking placeholder
  `0917 123 4567`.
- Text bodies use plain `'`, never `’` (GSM-7 keeps 160 characters per SMS).

## Task 1: phones

- [ ] `src/lib/fields.ts`: `UsPhone` → `Phone` (PH `09…` / `639…`, any `+` E.164, US 10 or
      11 digits). Rename at every import.
- [ ] `src/lib/fields.test.ts`: every row of the spec's phone table, plus refusals.
- [ ] Update the old copy `Enter a 10-digit phone number` in the API tests.
- [ ] relay-web `src/lib/format.ts`: `formatPhone` shows `+639171234567` as `0917 123 4567`.
- [ ] relay-web booking contact step: plain phone field, placeholder `0917 123 4567`; drop
      `UsPhoneInput` and `UsFlag`. Fix `problem-rows.test.ts` copy.
- [ ] Typecheck and tests in both repos; commit.

## Task 2: schema, settings, seed

- [ ] `schema.ts`: `messages.sendAfter`, `attempts`, `lastError`, checks, `messages_due_idx`;
      `WEBHOOK_PROVIDERS` + `'httpsms'`.
- [ ] `npm run db:generate` → `drizzle/0011_*.sql`; compare with the schema draft; migrate dev
      and test databases.
- [ ] `env.ts`: `SMS_PROVIDER` (`log` | `httpsms`, default `log`), `HTTPSMS_API_KEY`,
      `HTTPSMS_WEBHOOK_SIGNING_KEY` (both required with `httpsms`), `SEED_SMS_NUMBER`.
      Tests in `env.test.ts`. `.env.example` entries.
- [ ] `seed.ts`: `desert` timezone `Asia/Manila`; `phone_numbers` row from `SEED_SMS_NUMBER`.
- [ ] Commit.

## Task 3: rules and `sendText()`

- [ ] `src/modules/messaging/rules.ts`: `ruleFor(kind)` → `{ consent: 'required' | 'opt_out' |
      'none', quietHours: boolean }`, and `quietUntil(now, timezone, start, end)`.
- [ ] `rules.test.ts`: every kind in `MESSAGE_KINDS` placed; quiet window across midnight.
- [ ] `sms.ts`: consent lookup, quiet hours, `blocked` rows; sign-in codes sent at once.
- [ ] `sms.test.ts`; commit.

## Task 4: provider and sender loop

- [ ] `src/modules/messaging/httpsms.ts`: `sendSms({ from, to, content, requestId })`.
- [ ] `src/modules/messaging/sender.ts`: `sendDueTexts()`, `startSender()`, `stopSender()`.
- [ ] `server.ts`: start after jobs, stop before them.
- [ ] `sender.test.ts` with `vi.mock('./httpsms.ts')`; commit.

## Task 5: webhook

- [ ] `npm install jose`.
- [ ] `src/modules/messaging/webhooks.routes.ts` + service code; mount in `app.ts`.
- [ ] `webhooks.test.ts` (supertest, `SignJWT`); commit.

## Task 6: docs

- [ ] `docs/real-texting-todo.md`: tick what was built; US-only items under "US launch".
- [ ] README: how to set up the httpSMS phone, keys, and a tunnel for webhooks. Commit.
