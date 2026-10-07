# STOP and START Replies Implementation Plan

**Goal:** A homeowner's STOP reply stops every homeowner text to that number, including texts
already waiting to go out. `Stop.` and `stop!` count. START and UNSTOP undo it. The round trip
is tested.

**Architecture:** The webhook already writes the consent row (`receiveText()` in
`webhooks.service.ts`). This adds one update in the same transaction: on a STOP, waiting
homeowner texts for that number become `blocked` / `opted_out`. Which kinds are "homeowner"
comes from `TEXT_RULES` in `rules.ts`, the one place consent is decided. No schema change.

**Spec:** `relay-api/docs/superpowers/specs/2026-10-05-stop-start-replies-design.md`

## Global Constraints

- Branch `feat/stop-start-replies` in `relay-api`. API only; no `relay-web` change.
- Lean, plain code a junior developer can debug without AI. Short "why" comments.
- Commit messages lowercase conventional (`feat: …`, `test: …`). No `Co-Authored-By` trailer.
- Biome only on touched files: `npx biome check --write <paths>`.
- Tests need the local test database (`npm test` uses `test/global-setup.ts`).

## Task 1: homeowner kinds in rules.ts

- [ ] `src/modules/messaging/rules.ts`, below `TEXT_RULES`:
      ```ts
      // Kinds that go to homeowners: the ones whose rule checks consent. A STOP blocks these,
      // including any already waiting to go out (webhooks.service.ts).
      export const HOMEOWNER_KINDS = (Object.keys(TEXT_RULES) as MessageKind[]).filter(
        (kind) => TEXT_RULES[kind].consent !== 'none',
      )
      ```
- [ ] `rules.test.ts`: contains `on_my_way`, `text_back`, `reminder`, `manual`; doesn't contain
      `sign_in_code`, `job_assigned`, `new_booking_alert`, `priority_alert`, `inbound`.
- [ ] `npm test -- rules`.

## Task 2: block waiting texts on STOP

- [ ] `src/modules/messaging/messaging.queries.ts`, in the Webhooks section after
      `insertReplyConsent`:
      ```ts
      // After a STOP: texts to this number that are saved but not yet handed to httpSMS (held
      // for quiet hours, or waiting for a retry) are blocked, as sendText() would block them
      // now. A text already on the phone can't be called back.
      export async function blockWaitingTexts(
        tenantId: string,
        contact: string,
        kinds: MessageKind[],
        tx: Db,
      ) {
        await tx
          .update(messages)
          .set({ status: 'blocked', blockedReason: 'opted_out' })
          .where(
            and(
              eq(messages.tenantId, tenantId),
              eq(messages.contact, contact),
              eq(messages.channel, 'sms'),
              eq(messages.direction, 'outbound'),
              eq(messages.status, 'queued'),
              isNull(messages.providerMessageId),
              inArray(messages.kind, kinds),
            ),
          )
      }
      ```
      Import `type MessageKind` from `./rules.ts`.
- [ ] `src/modules/messaging/webhooks.service.ts → receiveText()`:
  - match with trailing `.` / `!` dropped:
    ```ts
    // The whole reply is the command. Trailing dots and bangs are dropped ("Stop.") because no
    // carrier catches STOP on an httpSMS phone: Relay is the only thing honoring it.
    const word = body.trim().replace(/[.!]+$/, '').toUpperCase()
    ```
  - after `insertReplyConsent`, when it was a STOP:
    ```ts
    if (!granted) await queries.blockWaitingTexts(tenantId, contact, HOMEOWNER_KINDS, tx)
    ```
    (pull `const granted = START_WORDS.includes(word)` into a variable first).
  - Update the comment above `START_WORDS`: a START from someone who never ticked the consent
    box counts as consent; they asked for texts.
- [ ] Commit `feat: a STOP reply also blocks texts already waiting to go out`.

## Task 3: tests

All in `src/modules/messaging/webhooks.test.ts`, reusing `shop()`, `post()`, `HOMEOWNER`.

- [ ] Helper `waiting(tenantId, values)` that inserts an outbound `queued` text to `HOMEOWNER`
      (`channel: 'sms'`, `body: 'x'`, `sendAfter` one hour ahead) and returns it; `values`
      overrides `kind`, `contact`, `providerMessageId`, `attempts`, `tenantId`.
- [ ] `it.each` over `['STOP', 'stopall', 'Unsubscribe', 'cancel', 'END', 'quit', 'Stop.',
      ' stop!! ']`: one consent row, `granted: false`, `source: 'sms_reply'`, `messageId` = the
      inbound text's id.
- [ ] `UNSTOP` writes `granted: true`.
- [ ] `'Please stop texting me'` and `'STOP?'`: inbound text saved, no consent row.
- [ ] No reply: after `STOP`, `messages` has exactly one row, `direction: 'inbound'`.
- [ ] Waiting texts: before the STOP, insert
  - `reminder` (held) → becomes `blocked`, `opted_out`;
  - `on_my_way` with `attempts: 1` (retrying) → `blocked`, `opted_out`;
  - `on_my_way` with `providerMessageId: 'httpsms-9'` (on the phone) → stays `queued`;
  - `job_assigned` (staff kind) → stays `queued`;
  - `reminder` for a second tenant (`createTenant('other')`) to the same number → stays
    `queued`.
- [ ] START doesn't revive: STOP then START, the blocked `reminder` stays `blocked`.
- [ ] Round trip, importing `sendText` from `./sms.ts`: webhook `STOP` →
      `sendText(tenant.id, { contact: HOMEOWNER, kind: 'text_back', body: 'x' })` saves
      `blocked` / `opted_out`; webhook `START` → the same call saves `queued`.
- [ ] `npm test -- webhooks sms rules`; then full `npm test`.
- [ ] Commit `test: stop and start replies, end to end`.

## Task 4: docs

- [ ] `docs/httpsms-setup.md`, step 5 "STOP": a STOP also blocks texts already waiting
      (quiet hours, retries); `Stop.` works; texts already on the phone still go.
- [ ] `docs/real-texting-todo.md`: under the existing `[x] STOP and START replies…` line, add
      `[x] A STOP blocks homeowner texts already waiting to go out.`
- [ ] `npx biome check --write` on the touched files; `npm run typecheck`.
- [ ] Commit `docs: stop reply blocks waiting texts`.

## Manual check (optional, with a real phone)

1. Set the contractor's quiet hours around now; create a booking so a `reminder` or other
   held homeowner text is `queued` with a future `send_after`.
2. Text `Stop.` from the homeowner phone to the httpSMS phone.
3. `select status, blocked_reason from messages where contact = '<phone>' order by created_at`:
   the held text is `blocked` / `opted_out`; the newest `consent_events` row is `false`.
4. Text `START`; the next homeowner text is `queued` and arrives.
