# Booking confirmation: a text and an email after an online booking

Date: 2026-10-04. Status: draft. Plan: `docs/superpowers/plans/2026-10-04-booking-confirmation.md`.

## Problem

`bookVisit()` in `src/modules/online-booking/online-booking.service.ts` books the visit, shows
"You're booked" on the page, and sends nothing. The homeowner leaves with no record of the day,
the window or the address, and the contractor gets calls asking "am I booked?".

Texts already work (`sendText()`, the sender loop, httpSMS; see
`2026-10-04-sms-service-design.md`), and `booking_confirmation` is already a message kind with
a rule. Email does not exist: the booking form collects an optional email, `messages.channel`
allows `'email'` and `messages.subject` is there, but nothing sends one.

## Goal

1. After an online booking is saved, the homeowner gets a confirmation **text** when they
   agreed to texts.
2. They also get a confirmation **email** when they typed an email address.
3. Email works like texts: saved in the caller's transaction, sent a few seconds later by the
   sender loop, retried, and recorded in `messages`. Gmail SMTP sends it.
4. Without a Gmail account (tests, most developers) everything still runs: emails are logged,
   not sent.

## Out of scope

- The reschedule / cancel link. Feature 2 (the manage page) adds it to both messages, so this
  feature never sends a link that leads nowhere.
- Confirmations for jobs the office books, the office's `new_booking_alert`, reminders.
- HTML email, templates, attachments, calendar invites. Plain text only.
- Email consent and unsubscribe. A booking receipt is transactional; marketing email is not
  part of Relay.
- Delivery and bounce tracking for email. SMTP only tells us Gmail accepted it.
- A sending domain (SPF, DKIM). Emails come from a Gmail address for the demo.

## What the homeowner gets

Both are written after the booking's rows are saved, in the same transaction as the booking,
so a booking that fails sends nothing and a booking that succeeds always has its messages.

### The text

Kind `booking_confirmation`: consent required, not held for quiet hours (rule `VISIT` in
`rules.ts`, unchanged). Without consent `sendText()` saves it as `blocked` / `no_consent`, as
for every other kind; `bookVisit()` doesn't check consent itself.

```
Desert Breeze Air: you're booked for AC Repair on Tue, Oct 6, 8:00 AM - 10:00 AM at
123 Main St. Pay at the visit. Reply STOP to opt out.
```

- `<tenant name>: you're booked for <service> on <day>, <window> at <street>[ <unit>]. Pay at
  the visit. Reply STOP to opt out.`
- Plain GSM characters only (see the SMS spec): `'` not `’`, and the window joined with
  ` - `, not the en dash `formatWindow()` uses for screens. A new `textWindow()` beside
  `formatWindow()` in `src/lib/labels.ts` returns `8:00 AM - 10:00 AM`.
- Street only, not city and ZIP: the homeowner knows where they live, and it keeps the text
  inside two SMS parts.
- `jobId` and `customerId` are set on the row.

### The email

Only when `input.email` is set. Kind `booking_confirmation`, channel `email`.

- **To:** the email typed in the form (already lowercased by `OptionalEmail`).
- **From:** `"<tenant name>" <SMTP_USER>`. Gmail rewrites any other address to the account's
  own, so the contractor's name is the display name.
- **Reply-To:** the tenant's `contactEmail`, so a reply reaches the contractor, not the Relay
  Gmail account.
- **Subject:** `Your visit is booked: Tue, Oct 6`
- **Body** (plain text):

```
Hi Maria,

Your visit with Desert Breeze Air is booked.

Service: AC Repair
Arrival window: Tue, Oct 6, 8:00 AM - 10:00 AM
Address: 123 Main St, Unit 4, Phoenix, AZ 85001
Priority service: $49.00, paid at the visit

There's nothing to pay now. You pay the technician at the visit.

Questions? Call 0917 123 4567 or reply to this email.

Desert Breeze Air
```

- First name: the text before the first space of `input.name`.
- The `Unit` part is left out when there is no unit; the `Priority service` line is left out
  when the fee is 0. The fee uses the tenant's currency.
- The phone is the tenant's `contactPhone`, shown with a new `formatPhone()` in
  `src/lib/labels.ts` that matches the web app's: `+639171234567` → `0917 123 4567`,
  `+14805550199` → `(480) 555-0199`, anything else as stored.

### Where the words are built

`src/modules/online-booking/confirmation.ts`, pure and tested:

```ts
confirmationText(v: Confirmation): string
confirmationEmail(v: Confirmation): { subject: string; body: string }
```

`Confirmation` holds what both need: tenant name, contact phone, currency, customer name,
service name, day label, window start and end, street, unit, city, state, zip, priority fee.
`bookVisit()` gathers these (`findActiveService` in `booking.queries.ts` also returns the
service's `name`) and calls `sendText()` and
`sendEmail()` with the results.

## Email service

### `sendEmail()`: `src/modules/messaging/email.ts`

```ts
sendEmail(
  tenantId: string,
  email: { contact: string; kind: MessageKind; subject: string; body: string;
           jobId?: string; customerId?: string },
  tx: Db = db,
)
```

Inserts a `messages` row: `channel 'email'`, `direction 'outbound'`, `status 'queued'`,
`send_after now()`. No consent check and no quiet hours: the only email today is a receipt for
something the homeowner just did. A future email that needs consent adds a rule then.

### The sender loop sends emails too

`sender.ts`, `sendDueTexts()` becomes `sendDueMessages()`: each round claims up to 20 due
texts and sends them, then up to 20 due emails and sends them. `claimDueTexts(limit)` becomes
`claimDue(channel, limit)` with the same lease (`attempts + 1`, `send_after` a minute ahead)
and `skip locked`. The claim also returns `subject`. The sign-in-code exclusion stays (it only
matters for texts). The partial index `messages_due_idx` already covers both channels.

`deliverEmail(email, lastTry)`:

- `EMAIL_PROVIDER=log`: marks the row `sent` and logs it; in development it prints the
  recipient, subject and body, like texts.
- `EMAIL_PROVIDER=smtp`: looks up the tenant's name and `contactEmail`, sends through
  `smtp.ts`, then marks the row `sent` and stores the returned `Message-ID` in
  `provider_message_id`. Email has no webhook, so `sent` is final.
- On an error: under 3 tries, `last_error` is stored and the row comes back a minute later; on
  the 3rd, `failed` with `last_error`. Same as texts.

### `smtp.ts`

One function, `sendMail({ fromName, to, replyTo, subject, text })`, returning the Message-ID.
One nodemailer transport, created on first use:

- `host SMTP_HOST`, `port SMTP_PORT`, `secure: SMTP_PORT === 465`,
  `auth { user: SMTP_USER, pass: SMTP_PASS }`.
- 10-second connection and socket timeouts, like `httpsms.ts`.

No provider interface: moving to a real email service later means replacing this one file.

## Settings (`src/config/env.ts`)

| Variable | Meaning |
| --- | --- |
| `EMAIL_PROVIDER` | `log` (default) or `smtp`. Tests always use `log`. |
| `SMTP_HOST` | Default `smtp.gmail.com`. |
| `SMTP_PORT` | Default `465`. |
| `SMTP_USER` | The Gmail address. Required when `EMAIL_PROVIDER=smtp`. |
| `SMTP_PASS` | A Gmail **app password** (Google account → Security → 2-Step Verification → App passwords), not the account password. Required when `EMAIL_PROVIDER=smtp`. |

`.env.example` gains the same lines. `docs/gmail-setup.md` explains making the app password,
like `docs/httpsms-setup.md`.

## Data

No migration. `messages` already has `channel` (`'sms' | 'email'`), `subject`, and the outbox
columns; `kind` already allows `booking_confirmation`.

## Limits to know

- A Gmail account sends about 500 emails a day; past that Google blocks sending for a day.
  Fine for a demo.
- Mail from a personal Gmail with another business's name may land in spam or "Promotions".
  A sending domain fixes that later.
- If Gmail takes the email and the process dies before the row is marked `sent`, the retry
  sends it twice. Same known gap as texts.

## New dependency

`nodemailer` and `@types/nodemailer` (dev).

## Tests

- `confirmation.test.ts`: the text and email for a booking with and without a unit and a
  priority fee; the text has only GSM characters (no `’`, no `–`).
- `labels.test.ts`: `textWindow()`; `formatPhone()` for PH, US and other numbers.
- `email.test.ts`: `sendEmail()` saves a queued email row with its subject.
- `sender.test.ts` (`smtp.ts` mocked with `vi.mock`): a due email is sent and marked `sent`
  with its Message-ID, a failure is retried, the 3rd failure is `failed`, a text round never
  claims emails and an email round never claims texts.
- `online-booking.test.ts`: a booking with consent queues a `booking_confirmation` text; without
  consent the text is `blocked`; with an email it queues an email; without one it doesn't; a
  booking refused (`window_full`) saves no messages.
- `env.test.ts`: `EMAIL_PROVIDER=smtp` without `SMTP_USER` or `SMTP_PASS` is refused.

## Build order

1. `textWindow()`, `formatPhone()`, `confirmation.ts` and their tests.
2. Env settings, `nodemailer`, `smtp.ts`, `sendEmail()`.
3. The sender loop sends emails.
4. `bookVisit()` sends both.
5. `docs/gmail-setup.md`, `.env.example`.
