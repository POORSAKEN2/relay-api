# Two-way text inbox

Date: 2026-10-06. Status: proposed. Plan: `docs/superpowers/plans/2026-10-06-text-inbox.md`.
Depends on: nothing new. Roadmap: `specs/2026-10-06-mvp-remaining-work.md` (step 2).

## Problem

MVP module 3: "Two-way text inbox for the office to reply by hand."

What already exists:

- Inbound texts are saved: httpSMS `message.phone.received` → `webhooks.service.ts →
  receiveText` inserts a `messages` row (`direction = 'inbound'`, `status = 'received'`,
  `kind = 'inbound'`, `customer_id` matched by phone). STOP / START replies change consent.
- Every outbound text is a `messages` row written by `sendText()`.
- `messages.read_at` ("inbound only: inbox unread state") and `messages.sent_by_user_id`
  ("office reply typed in the inbox") exist, unused.
- Index `messages_thread_idx (tenant_id, contact, created_at desc)`.
- Kind `manual` with rule `REPLY` (allowed unless they texted STOP, any hour).
- Socket.IO rooms per contractor (`realtime/`), `useSocketEvent` in `relay-web`.

Nothing lists or shows the texts, and the office can't reply.

## Goal

1. Owner and office see SMS conversations with homeowners, one thread per phone number, newest
   first, with unread counts.
2. Opening a thread shows its texts oldest to newest, marks it read, and lets staff reply.
3. A reply goes through `sendText()` (kind `manual`, `sent_by_user_id` set), so STOP is honored.
4. A new inbound text shows up without a reload.

## Out of scope

- Starting a conversation with a number that has no thread (consent risk; the office can still
  book and the confirmation starts the thread).
- Email in the inbox. SMS only.
- Search, archive, assigning threads to a person, MMS / photos.
- Live status updates of a sent reply (sent → delivered). The thread refetches on focus.

## What a thread is

All SMS `messages` rows of one contractor with one `contact`, **except texts to the
contractor's own staff** (`to_user_id is not null`: job assigned, office alerts, sign-in codes).
Every text Relay sends a homeowner is in their thread (confirmation, reminders, text-back, …),
so staff see what the homeowner saw before replying.

## API

All routes: signed-in owner or office (`requireRole('owner', 'office')`), the user's own
contractor only.

### `GET /api/inbox/threads`

The 50 most recently active threads.

```json
{
  "threads": [
    {
      "contact": "+16025550111",
      "customer": { "id": "…", "name": "Maria Lopez" },
      "lastMessage": { "body": "Can you come earlier?", "direction": "inbound", "createdAt": "…" },
      "unread": 2
    }
  ],
  "unreadTotal": 3
}
```

- `customer`: the oldest customer with that phone (`findCustomerIdByPhone` rule), or null.
- `unread`: inbound texts in the thread with `read_at is null`. `unreadTotal`: over all threads
  (for the sidebar badge).

### `GET /api/inbox/messages?contact=+16025550111`

The thread's last 100 texts, oldest first: `id, direction, kind, body, status, blockedReason,
createdAt, sentBy: { name } | null`. 404 if the contractor has no text with that contact.

### `POST /api/inbox/messages` `{ contact, body }`

- `body`: trimmed, 1 to 640 characters (4 SMS segments).
- 404 if there is no thread with that contact (no cold texts).
- Saves through `sendText(tenantId, { contact, kind: 'manual', body, sentByUserId, customerId })`.
- Answers `201` with the saved message. A reply to someone who texted STOP is saved as
  `blocked` and returned that way; the screen says "Not sent: they opted out".
- Audit: `message.sent` with the user as actor (body not copied into the audit log).

### `POST /api/inbox/read` `{ contact }`

Sets `read_at = now()` on the thread's unread inbound texts. Answers `204`.

## Realtime

New event `inbox.updated` `{ contact }`, emitted to the contractor's room after a text arrives
(after the webhook's transaction commits, never inside it). The web app refetches the thread
list, the badge, and the open thread when it matches.

## Screen (`relay-web`)

- Sidebar link **Inbox** (icon `MessageSquare`), with the unread total as a small badge.
- Route `/inbox`. Desktop: thread list on the left, open thread on the right.
  Phone: the list, and `/inbox?contact=…` shows one thread with a back button.
- Thread list row: customer name or formatted phone, last text (one line), time, unread dot.
- Thread: bubbles (homeowner left, contractor right), each outbound one labeled with who sent it
  ("Relay" for automatic texts, the staff member's name for replies) and a small status
  ("Not sent: opted out", "Failed"). Customer name links to `/customers/:id`.
- Reply box at the bottom: textarea, character count, Send. `Enter` sends, `Shift+Enter` makes a
  new line. Disabled while sending.
- Empty states: "No texts yet. Replies from homeowners show up here."

## Edge cases

| Case | Result |
|---|---|
| Homeowner texts STOP | shows in the thread; a later reply is saved `blocked` |
| Phone shared by two customers | one thread, the oldest customer's name |
| Text from a number with no customer | thread shows the formatted number |
| Office user of another contractor | never sees these threads (tenant filter) |
| Technician | 403 |
| Reply to a contact with no thread | 404 |
| Empty or 641-character reply | 400 `validation_failed` |
| Night time | reply sent (`manual` skips quiet hours: staff are answering them) |

## Testing

- `inbox.test.ts` (HTTP, test DB): thread list order, `unread`, `unreadTotal`, staff texts left
  out, customer name; messages oldest first with `sentBy`; reply saved as `manual` with
  `sent_by_user_id`; reply after STOP is `blocked`; read marks only that thread; 401 / 403 / 404
  / 400 cases; another contractor sees nothing.
- `webhooks.test.ts`: an inbound text emits `inbox.updated` (spy on `emitToTenant`).
- `relay-web`: pure helpers (thread title, sender label) unit tested.
