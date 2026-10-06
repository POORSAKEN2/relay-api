# Text Inbox Implementation Plan

**Goal:** Owner and office read SMS threads with homeowners and reply by hand. Replies go
through the compliance gate.

**Architecture:** New `inbox` module in `relay-api` (routes → service → queries) over the
existing `messages` table; a new realtime event `inbox.updated`. New `/inbox` screen and sidebar
link in `relay-web`. No schema change.

**Spec:** `relay-api/docs/superpowers/specs/2026-10-06-text-inbox-design.md`

## Global Constraints

- Branch `feat/text-inbox` in `relay-api` and `relay-web`, from `main`.
- Lean, plain code a junior developer can debug without AI. Short "why" comments.
- Commit messages lowercase conventional. No `Co-Authored-By` trailer.
- Biome only on touched files.

## Task 1: `sendText` records who typed it

- [ ] `messaging/sms.ts`: add `sentByUserId?: string // office reply typed in the inbox` to the
      `text` parameter (spread into the insert already).

## Task 2: inbox queries

- [ ] `src/modules/inbox/inbox.queries.ts`:
      - `homeownerTexts(tenantId)`: the shared `where`: tenant, `channel = 'sms'`,
        `to_user_id is null`. Every query below uses it, so staff texts never leak in.
      - `listThreads(tenantId, limit)`: one row per contact with the latest text. Plain SQL with
        `distinct on (contact) … order by contact, created_at desc`, wrapped to re-sort by
        `created_at desc`, plus `count(*) filter (where direction = 'inbound' and read_at is null)`
        per contact and the customer name (oldest customer with that phone, lateral join).
      - `countUnread(tenantId)`.
      - `listThreadMessages(tenantId, contact, limit)`: newest 100, left join `users` for
        `sentBy.name`, returned oldest first (reverse in the service).
      - `threadExists(tenantId, contact)`.
      - `markThreadRead(tenantId, contact)`.
- [ ] Commit `feat: inbox queries over homeowner texts`.

## Task 3: inbox routes and service

- [ ] `inbox.schemas.ts`: `ThreadQuery { contact: Phone }`, `ReplyInput { contact: Phone, body:
      string().trim().min(1, 'Type a reply').max(640, 'Keep it to 640 characters') }`,
      `ReadInput { contact: Phone }`. `Phone` from `lib/fields.ts` (E.164).
- [ ] `inbox.service.ts`: `listThreads(user)`, `getThread(user, contact)` (404 when no thread),
      `reply(user, input)`:
      ```ts
      // Only threads the homeowner is already in: the inbox is for answering, not cold texts.
      if (!(await queries.threadExists(tenantId, input.contact))) throw notFound
      return db.transaction(async (tx) => {
        const customerId = await findCustomerIdByPhone(tenantId, input.contact, tx)
        const message = await sendText(tenantId, { contact: input.contact, kind: 'manual',
          body: input.body, sentByUserId: user.id, customerId }, tx)
        await audit.insertUserAction(tenantId, { actorUserId: user.id, action: 'message.sent',
          entityType: 'message', entityId: message.id, data: { kind: 'manual' } }, tx)
        return message
      })
      ```
      `sendText` must return the saved row: change its last lines to `return message` (it only
      returns nothing today; no caller breaks).
      `markRead(user, contact)`.
- [ ] `inbox.routes.ts`: the four routes, `requireRole('owner', 'office')`. Mount in `app.ts`.
- [ ] `inbox.test.ts`: the spec's Testing list.
- [ ] Commit `feat: inbox api to read and reply to homeowner texts`.

## Task 4: realtime

- [ ] `realtime/events.ts`: `'inbox.updated': { contact: string }`.
- [ ] `webhooks.service.ts`: `handleHttpSmsEvent` collects what to announce inside the
      transaction (`receiveText` returns `{ tenantId, contact }`) and calls
      `emitToTenant(tenantId, 'inbox.updated', { contact })` after the transaction resolves.
- [ ] Test with a spy on `emitToTenant`.
- [ ] Commit `feat: tell the office when a text arrives`.

## Task 5: the screen (relay-web)

- [ ] `src/lib/socket.ts`: add `'inbox.updated': { contact: string }` to `RealtimeEvents`.
- [ ] `src/features/inbox/api.ts`: zod schemas for the three responses; hooks
      `useThreads()`, `useThread(contact)`, `useReply()`, `useMarkRead()`. `useSocketEvent('inbox.updated', …)`
      invalidates `['inbox']`.
- [ ] `src/features/inbox/labels.ts` (+ test): `threadTitle(thread)` (name or formatted phone),
      `senderLabel(message)` ("Relay" / staff name / homeowner), `statusNote(message)`
      ("Not sent: they opted out", "Failed to send", or null).
- [ ] `src/features/inbox/thread-list.tsx`, `thread-view.tsx`, `reply-box.tsx`.
- [ ] `src/routes/inbox.tsx`: two panes from `lg` up; below `lg`, the list or the thread by
      `?contact=`. Opening a thread calls `useMarkRead`.
- [ ] `router.tsx`: `/inbox` in the staff routes. `components/sidebar-links.ts`: Inbox link
      after Dispatch; the sidebar shows `unreadTotal` as a badge (from `useThreads`).
- [ ] Check in headless Edge (phone width and desktop): list, open, reply, badge clears.
- [ ] Commit `feat: inbox screen for texts with homeowners`.
