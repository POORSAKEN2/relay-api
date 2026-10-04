# Booking Confirmation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After an online booking, the homeowner gets a confirmation text (when they agreed to
texts) and a confirmation email (when they typed an email), the email sent through Gmail SMTP.

**Architecture:** `messages` stays the outbox for both channels. A new `sendEmail()` saves a
`queued` email row in the caller's transaction, beside the existing `sendText()`. The sender
loop's round claims due texts, then due emails (`claimDue(channel, limit)`), and hands emails
to `smtp.ts` (nodemailer). `bookVisit()` builds both messages with the pure `confirmation.ts`
and saves them in the booking's transaction.

**Tech Stack:** Node 22 (type stripping), Express 5, Drizzle + PostgreSQL, Zod 4, Vitest +
supertest, nodemailer.

**Spec:** `relay-api/docs/superpowers/specs/2026-10-04-booking-confirmation-design.md`

## Global Constraints

- Branch `feat/booking-confirmation` in `relay-api` only (no web change), based on
  `origin/main`.
- Lean, plain code a junior developer can debug without AI. Short "why" comments, matching the
  files around them.
- Commit messages lowercase conventional (`feat: …`, `docs: …`), ending with the
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` line.
- Biome only on touched files: `npx biome check --write <paths>`.
- Every test run needs the local test database (`TEST_DATABASE_URL` in `.env`).
- Text bodies use only plain characters: `'` not `’`, ` - ` not `–`.
- Exact copy, from the spec:
  - Text: `<tenant>: you're booked for <service> on <day>, <window> at <street>[, <unit>]. Pay at the visit. Reply STOP to opt out.`
  - Email subject: `Your visit is booked: <day>`
- `EMAIL_PROVIDER` is `log` (default) or `smtp`; tests always use `log` unless a test sets
  `env.EMAIL_PROVIDER` itself and puts it back.
- No migration: `messages.channel`, `messages.subject` and the outbox columns already exist.

## Review Focus

1. A contractor or service name typed with a curly apostrophe or an en dash (`Rico’s Air`) →
   the text still has only plain characters. Test in Task 1.
2. The email field left blank (`''`) → no email row at all, not one sent to `''`. Test in
   Task 4.
3. A Gmail app password pasted with Google's spaces (`abcd efgh ijkl mnop`) → works. Test in
   Task 2.
4. Gmail refusing or timing out → the booking is unaffected, and the email is retried, then
   `failed`. Test in Task 3.
5. A booking refused for a full window → no text and no email saved. Test in Task 4.

## Files

| File | Change |
| --- | --- |
| `src/lib/labels.ts`, `labels.test.ts` | `textWindow()`, `formatPhone()`, `formatMoney()` |
| `src/modules/online-booking/confirmation.ts`, `confirmation.test.ts` | New: the words of the text and the email |
| `src/config/env.ts`, `env.test.ts`, `vitest.config.ts`, `.env.example` | Email settings |
| `src/modules/messaging/smtp.ts` | New: one nodemailer transport, `sendMail()` |
| `src/modules/messaging/email.ts`, `email.test.ts` | New: `sendEmail()` |
| `src/modules/messaging/messaging.queries.ts` | `claimDue(channel, limit)`, `markEmailSent()`, `findEmailSender()` |
| `src/modules/messaging/sender.ts`, `sender.test.ts` | `sendDueMessages()`, `deliverEmail()` |
| `src/modules/booking/booking.queries.ts` | `findActiveService` also returns `name` |
| `src/modules/online-booking/online-booking.service.ts`, `online-booking.test.ts` | `bookVisit()` sends both |
| `docs/gmail-setup.md` | New: how to make the app password |

---

### Task 1: The words of the confirmation

**Files:**
- Modify: `src/lib/labels.ts`
- Test: `src/lib/labels.test.ts`
- Create: `src/modules/online-booking/confirmation.ts`
- Test: `src/modules/online-booking/confirmation.test.ts`

**Interfaces:**
- Produces:
  - `textWindow(startsAt: Date, endsAt: Date, timezone: string): string`, giving `'8 AM - 12 PM'`
  - `formatPhone(phone: string): string`
  - `formatMoney(cents: number, currency: string): string`
  - `type Confirmation`, `confirmationText(v: Confirmation): string`,
    `confirmationEmail(v: Confirmation): { subject: string; body: string }`

- [ ] **Step 1: Write the failing label tests**

Add to `src/lib/labels.test.ts` (extend the import to
`import { formatClock, formatDate, formatMoney, formatPhone, textWindow } from './labels.ts'`):

```ts
it('writes a window for a text, with a plain hyphen', () => {
  // Phoenix is UTC-7 all year.
  const start = new Date('2030-01-08T15:00:00Z')
  const end = new Date('2030-01-08T19:00:00Z')
  expect(textWindow(start, end, 'America/Phoenix')).toBe('8 AM - 12 PM')
})

it('shows a phone the way people write it', () => {
  expect(formatPhone('+639171234567')).toBe('0917 123 4567')
  expect(formatPhone('+14805550100')).toBe('(480) 555-0100')
  expect(formatPhone('+442071234567')).toBe('+442071234567')
})

it('shows cents as money in the contractor’s currency', () => {
  expect(formatMoney(4900, 'USD')).toBe('$49.00')
  expect(formatMoney(150000, 'PHP')).toBe('₱1,500.00')
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/lib/labels.test.ts`
Expected: FAIL, `textWindow` / `formatPhone` / `formatMoney` is not exported.

- [ ] **Step 3: Add the three helpers to `src/lib/labels.ts`**

Below `formatWindow()`:

```ts
// '8 AM - 12 PM', for a text. formatWindow's en dash would switch the whole text to Unicode,
// which halves how much fits in one SMS.
export function textWindow(startsAt: Date, endsAt: Date, timezone: string): string {
  return `${formatClock(startsAt, timezone)} - ${formatClock(endsAt, timezone)}`
}
```

At the end of the file:

```ts
// '+639171234567' → '0917 123 4567', '+14805550100' → '(480) 555-0100'. Same as the web
// app's formatPhone. Any other number is shown as stored.
export function formatPhone(phone: string): string {
  const ph = /^\+63(9\d{2})(\d{3})(\d{4})$/.exec(phone)
  if (ph) return `0${ph[1]} ${ph[2]} ${ph[3]}`
  const us = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(phone)
  if (us) return `(${us[1]}) ${us[2]}-${us[3]}`
  return phone
}

// 4900, 'USD' → '$49.00'
export function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100)
}
```

- [ ] **Step 4: Run the label tests**

Run: `npx vitest run src/lib/labels.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing confirmation tests**

Create `src/modules/online-booking/confirmation.test.ts`:

```ts
import { expect, it } from 'vitest'
import { type Confirmation, confirmationEmail, confirmationText } from './confirmation.ts'

const booking: Confirmation = {
  tenantName: 'Desert Breeze Air',
  contactPhone: '+639171234567',
  currency: 'USD',
  customerName: 'Maria Lopez',
  serviceName: 'AC Repair',
  dayLabel: 'Tue, Oct 6',
  windowLabel: '8 AM - 12 PM',
  street: '123 Main St',
  unit: null,
  city: 'Phoenix',
  state: 'AZ',
  zip: '85001',
  priorityFeeCents: 0,
}

// Plain characters only: anything else switches a text to Unicode (70 characters per part).
const PLAIN = /^[\x20-\x7E]*$/

it('writes the confirmation text', () => {
  expect(confirmationText(booking)).toBe(
    "Desert Breeze Air: you're booked for AC Repair on Tue, Oct 6, 8 AM - 12 PM at 123 Main St. Pay at the visit. Reply STOP to opt out.",
  )
  expect(confirmationText({ ...booking, unit: 'Unit 4' })).toContain('at 123 Main St, Unit 4.')
})

it('keeps the text plain when a name was typed with curly quotes or dashes', () => {
  const text = confirmationText({
    ...booking,
    tenantName: 'Rico’s Air – Cooling',
    serviceName: '“Tune-up”',
  })
  expect(text).toMatch(PLAIN)
  expect(text).toContain("Rico's Air - Cooling")
  expect(text).toContain('"Tune-up"')
})

it('writes the confirmation email', () => {
  expect(confirmationEmail(booking)).toEqual({
    subject: 'Your visit is booked: Tue, Oct 6',
    body: [
      'Hi Maria,',
      '',
      'Your visit with Desert Breeze Air is booked.',
      '',
      'Service: AC Repair',
      'Arrival window: Tue, Oct 6, 8 AM - 12 PM',
      'Address: 123 Main St, Phoenix, AZ 85001',
      '',
      "There's nothing to pay now. You pay the technician at the visit.",
      '',
      'Questions? Call 0917 123 4567 or reply to this email.',
      '',
      'Desert Breeze Air',
    ].join('\n'),
  })
})

it('adds the unit and the priority fee to the email when there are some', () => {
  const { body } = confirmationEmail({ ...booking, unit: 'Unit 4', priorityFeeCents: 4900 })
  expect(body).toContain('Address: 123 Main St, Unit 4, Phoenix, AZ 85001')
  expect(body).toContain('Priority service: $49.00, paid at the visit')
})
```

- [ ] **Step 6: Run them to see them fail**

Run: `npx vitest run src/modules/online-booking/confirmation.test.ts`
Expected: FAIL, cannot find module `./confirmation.ts`.

- [ ] **Step 7: Write `src/modules/online-booking/confirmation.ts`**

```ts
import { formatMoney, formatPhone } from '../../lib/labels.ts'

// What the homeowner is told right after booking online: one text and, when they gave an
// email, one email. Pure, so the words are tested without a database.

export type Confirmation = {
  tenantName: string
  contactPhone: string // the contractor's, E.164
  currency: string
  customerName: string
  serviceName: string
  dayLabel: string // 'Tue, Oct 6' (formatDay)
  windowLabel: string // '8 AM - 12 PM' (textWindow)
  street: string
  unit: string | null
  city: string
  state: string
  zip: string
  priorityFeeCents: number
}

// Curly quotes and dashes typed into a name would switch the whole text to Unicode.
export function plainText(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
}

export function confirmationText(v: Confirmation): string {
  const street = v.unit ? `${v.street}, ${v.unit}` : v.street
  return plainText(
    `${v.tenantName}: you're booked for ${v.serviceName} on ${v.dayLabel}, ${v.windowLabel} at ${street}. Pay at the visit. Reply STOP to opt out.`,
  )
}

export function confirmationEmail(v: Confirmation): { subject: string; body: string } {
  const firstName = v.customerName.split(' ')[0]
  const address = [v.street, v.unit, v.city, `${v.state} ${v.zip}`].filter(Boolean).join(', ')
  const priority =
    v.priorityFeeCents > 0
      ? [`Priority service: ${formatMoney(v.priorityFeeCents, v.currency)}, paid at the visit`]
      : []
  const body = [
    `Hi ${firstName},`,
    '',
    `Your visit with ${v.tenantName} is booked.`,
    '',
    `Service: ${v.serviceName}`,
    `Arrival window: ${v.dayLabel}, ${v.windowLabel}`,
    `Address: ${address}`,
    ...priority,
    '',
    "There's nothing to pay now. You pay the technician at the visit.",
    '',
    `Questions? Call ${formatPhone(v.contactPhone)} or reply to this email.`,
    '',
    v.tenantName,
  ]
  return { subject: `Your visit is booked: ${v.dayLabel}`, body: body.join('\n') }
}
```

- [ ] **Step 8: Run the tests, typecheck and lint**

Run: `npx vitest run src/lib/labels.test.ts src/modules/online-booking/confirmation.test.ts`
Expected: PASS.
Run: `npm run typecheck`
Expected: no errors.
Run: `npx biome check --write src/lib/labels.ts src/lib/labels.test.ts src/modules/online-booking/confirmation.ts src/modules/online-booking/confirmation.test.ts`

- [ ] **Step 9: Commit**

```bash
git add src/lib/labels.ts src/lib/labels.test.ts src/modules/online-booking/confirmation.ts src/modules/online-booking/confirmation.test.ts
git commit -m "feat: words for the booking confirmation text and email" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Email settings, SMTP and `sendEmail()`

**Files:**
- Modify: `src/config/env.ts`, `src/config/env.test.ts`, `vitest.config.ts`, `.env.example`,
  `package.json` (via npm)
- Create: `src/modules/messaging/smtp.ts`
- Create: `src/modules/messaging/email.ts`
- Test: `src/modules/messaging/email.test.ts`

**Interfaces:**
- Consumes: `queries.insertText(values, tx)` from `messaging.queries.ts` (a plain insert into
  `messages`, despite its name), `MessageKind` from `rules.ts`.
- Produces:
  - `env.EMAIL_PROVIDER: 'log' | 'smtp'`, `env.SMTP_HOST: string`, `env.SMTP_PORT: number`,
    `env.SMTP_USER?: string`, `env.SMTP_PASS?: string`
  - `sendMail(mail: { fromName: string; to: string; replyTo: string; subject: string; text: string }): Promise<string>`
    returns the Message-ID
  - `sendEmail(tenantId: string, email: { contact: string; kind: MessageKind; subject: string; body: string; jobId?: string; customerId?: string }, tx?: Db): Promise<void>`

- [ ] **Step 1: Install nodemailer**

Run: `npm install nodemailer && npm install -D @types/nodemailer`
Expected: both added to `package.json`.

- [ ] **Step 2: Write the failing env tests**

In `src/config/env.test.ts`, change the expected object in `'fills in defaults'` to:

```ts
  expect(parseEnv(required)).toEqual({
    ...required,
    NODE_ENV: 'development',
    PORT: 3000,
    LOG_LEVEL: 'info',
    SMS_PROVIDER: 'log',
    EMAIL_PROVIDER: 'log',
    SMTP_HOST: 'smtp.gmail.com',
    SMTP_PORT: 465,
  })
```

And add at the end:

```ts
it('needs the Gmail address and app password to send real emails', () => {
  expect(() => parseEnv({ ...required, EMAIL_PROVIDER: 'smtp' })).toThrow(/SMTP_USER/)
  expect(() => parseEnv({ ...required, EMAIL_PROVIDER: 'smtp' })).toThrow(/SMTP_PASS/)
  const gmail = { SMTP_USER: 'relay.demo@gmail.com', SMTP_PASS: 'abcdefghijklmnop' }
  expect(parseEnv({ ...required, EMAIL_PROVIDER: 'smtp', ...gmail }).EMAIL_PROVIDER).toBe('smtp')
})

it('takes the app password as Google shows it, with spaces', () => {
  expect(parseEnv({ ...required, SMTP_PASS: 'abcd efgh ijkl mnop' }).SMTP_PASS).toBe(
    'abcdefghijklmnop',
  )
})
```

- [ ] **Step 3: Run them to see them fail**

Run: `npx vitest run src/config/env.test.ts`
Expected: FAIL. The defaults have no `EMAIL_PROVIDER`, and `smtp` is not a valid value.

- [ ] **Step 4: Add the settings to `src/config/env.ts`**

After `SEED_SMS_NUMBER` in the object:

```ts
    // 'log' sends nothing: emails are logged (printed in development). 'smtp' really sends,
    // through Gmail for the demo (docs/gmail-setup.md).
    EMAIL_PROVIDER: z.enum(['log', 'smtp']).default('log'),
    SMTP_HOST: z.string().min(1).default('smtp.gmail.com'),
    SMTP_PORT: z.coerce.number().int().positive().default(465),
    SMTP_USER: z.email().optional(), // the Gmail address emails are sent from
    // A Gmail app password. Google shows it in groups of four with spaces; they don't count.
    SMTP_PASS: z
      .string()
      .transform((value) => value.replace(/\s/g, ''))
      .pipe(z.string().min(1))
      .optional(),
```

Replace the whole `.superRefine(...)` with:

```ts
  .superRefine((env, ctx) => {
    const needs = (names: (keyof typeof env)[], why: string) => {
      for (const name of names) {
        if (!env[name]) ctx.addIssue({ code: 'custom', path: [name], message: why })
      }
    }
    if (env.SMS_PROVIDER === 'httpsms') {
      needs(['HTTPSMS_API_KEY', 'HTTPSMS_WEBHOOK_SIGNING_KEY'], 'Required with SMS_PROVIDER=httpsms')
    }
    if (env.EMAIL_PROVIDER === 'smtp') {
      needs(['SMTP_USER', 'SMTP_PASS'], 'Required with EMAIL_PROVIDER=smtp')
    }
  })
```

- [ ] **Step 5: Keep tests on `log`, and document the settings**

In `vitest.config.ts`, under `SMS_PROVIDER: 'log', …` add:

```ts
      EMAIL_PROVIDER: 'log', // tests never send a real email, whatever .env says
```

At the end of `.env.example`:

```
# Email. 'log' sends nothing and prints each email here instead. 'smtp' sends through Gmail:
# see docs/gmail-setup.md. SMTP_PASS is a Gmail app password, not the account password.
EMAIL_PROVIDER=log
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=
SMTP_PASS=
```

- [ ] **Step 6: Run the env tests**

Run: `npx vitest run src/config/env.test.ts`
Expected: PASS.

- [ ] **Step 7: Write `src/modules/messaging/smtp.ts`**

No test of its own: it only passes values to nodemailer. Task 3 mocks it, and
`docs/gmail-setup.md` (Task 3) has the manual check.

```ts
import nodemailer, { type Transporter } from 'nodemailer'
import { env } from '../../config/env.ts'

// Sends one email through SMTP (Gmail for the demo). Moving to a real email service later
// means replacing this one file.

let transport: Transporter | undefined

// Returns the email's Message-ID. Throws when the server refuses it or doesn't answer.
export async function sendMail(mail: {
  fromName: string // the contractor's name; the address is always the Gmail account's
  to: string
  replyTo: string // the contractor's own email, so replies reach them
  subject: string
  text: string
}) {
  transport ??= nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    connectionTimeout: 10_000,
    socketTimeout: 10_000,
  })
  const info = await transport.sendMail({
    from: { name: mail.fromName, address: env.SMTP_USER! },
    to: mail.to,
    replyTo: mail.replyTo,
    subject: mail.subject,
    text: mail.text,
  })
  return info.messageId
}
```

- [ ] **Step 8: Write the failing `sendEmail()` test**

Create `src/modules/messaging/email.test.ts`:

```ts
import { beforeEach, expect, it } from 'vitest'
import { createTenant, resetDb } from '../../../test/helpers.ts'
import { db } from '../../db/client.ts'
import { messages } from '../../db/schema.ts'
import { sendEmail } from './email.ts'

beforeEach(resetDb)

it('saves a queued email, for the sender loop to send', async () => {
  const tenant = await createTenant('desert')

  await sendEmail(tenant.id, {
    contact: 'sam@example.com',
    kind: 'booking_confirmation',
    subject: 'Your visit is booked: Tue, Jan 8',
    body: 'Hi Sam',
  })

  expect(await db.select().from(messages)).toEqual([
    expect.objectContaining({
      tenantId: tenant.id,
      channel: 'email',
      direction: 'outbound',
      status: 'queued',
      contact: 'sam@example.com',
      kind: 'booking_confirmation',
      subject: 'Your visit is booked: Tue, Jan 8',
      body: 'Hi Sam',
      attempts: 0,
    }),
  ])
})
```

- [ ] **Step 9: Run it to see it fail**

Run: `npx vitest run src/modules/messaging/email.test.ts`
Expected: FAIL, cannot find module `./email.ts`.

- [ ] **Step 10: Write `src/modules/messaging/email.ts`**

```ts
import { type Db, db } from '../../db/client.ts'
import * as queries from './messaging.queries.ts'
import type { MessageKind } from './rules.ts'

// Every email Relay sends starts here, like texts start at sendText(). It saves the email in
// the caller's transaction, so a change and its email are saved together or not at all; the
// sender loop (sender.ts) sends it a few seconds later. No consent or quiet hours: the only
// email today is a receipt for something the homeowner just did.
export async function sendEmail(
  tenantId: string,
  email: {
    contact: string // the email address
    kind: MessageKind
    subject: string
    body: string
    jobId?: string
    customerId?: string
  },
  tx: Db = db,
) {
  await queries.insertText(
    { tenantId, channel: 'email', direction: 'outbound', status: 'queued', ...email },
    tx,
  )
}
```

- [ ] **Step 11: Run the tests, typecheck and lint**

Run: `npx vitest run src/config/env.test.ts src/modules/messaging/email.test.ts`
Expected: PASS.
Run: `npm run typecheck`
Expected: no errors.
Run: `npx biome check --write src/config/env.ts src/config/env.test.ts vitest.config.ts src/modules/messaging/smtp.ts src/modules/messaging/email.ts src/modules/messaging/email.test.ts`

- [ ] **Step 12: Commit**

```bash
git add package.json package-lock.json .env.example vitest.config.ts src/config/env.ts src/config/env.test.ts src/modules/messaging/smtp.ts src/modules/messaging/email.ts src/modules/messaging/email.test.ts
git commit -m "feat: email settings, gmail smtp and sendEmail" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The sender loop sends emails

**Files:**
- Modify: `src/modules/messaging/messaging.queries.ts`
- Modify: `src/modules/messaging/sender.ts`
- Test: `src/modules/messaging/sender.test.ts`
- Create: `docs/gmail-setup.md`

**Interfaces:**
- Consumes: `sendMail()` from `smtp.ts` (Task 2), `env.EMAIL_PROVIDER` (Task 2).
- Produces:
  - `claimDue(channel: 'sms' | 'email', limit: number)` → rows
    `{ id, tenantId, contact, subject: string | null, body, attempts }` (replaces `claimDueTexts`)
  - `markEmailSent(messageId: string, providerMessageId: string)`
  - `findEmailSender(tenantId: string)` → `{ name: string; contactEmail: string }`
  - `sendDueMessages(): Promise<number>` (replaces `sendDueTexts`)
  - `deliverEmail(email: OutgoingEmail, lastTry: boolean)`
  - `deliver(text, lastTry)` keeps its name and signature: `sms.ts` uses it for sign-in codes.

- [ ] **Step 1: Point the existing sender tests at the new name**

In `src/modules/messaging/sender.test.ts` replace every `sendDueTexts` with `sendDueMessages`
(the import and every call).

- [ ] **Step 2: Write the failing email tests**

In `src/modules/messaging/sender.test.ts`:

Add the mock and import next to the httpSMS ones:

```ts
import { sendMail } from './smtp.ts'

vi.mock('./smtp.ts', () => ({ sendMail: vi.fn() }))
```

Make the hooks reset it too:

```ts
beforeEach(async () => {
  await resetDb()
  vi.mocked(sendSms).mockReset()
  vi.mocked(sendMail).mockReset()
  env.SMS_PROVIDER = 'httpsms'
})
afterEach(() => {
  env.SMS_PROVIDER = 'log'
  env.EMAIL_PROVIDER = 'log'
})
```

Add a helper below `queueText`:

```ts
async function queueEmail(tenantId: string) {
  const [email] = await db
    .insert(messages)
    .values({
      tenantId,
      channel: 'email',
      direction: 'outbound',
      status: 'queued',
      contact: 'sam@example.com',
      kind: 'booking_confirmation',
      subject: 'Your visit is booked: Tue, Jan 8',
      body: 'Hi Sam',
    })
    .returning()
  return email
}
```

Add the tests at the end:

```ts
it('sends a due email as the contractor, with replies going to the contractor', async () => {
  env.EMAIL_PROVIDER = 'smtp'
  const tenant = await createTenant('desert')
  const email = await queueEmail(tenant.id)
  vi.mocked(sendMail).mockResolvedValue('<abc@gmail.com>')

  expect(await sendDueMessages()).toBe(1)

  expect(sendMail).toHaveBeenCalledWith({
    fromName: 'desert HVAC',
    to: 'sam@example.com',
    replyTo: 'office@desert.test',
    subject: 'Your visit is booked: Tue, Jan 8',
    text: 'Hi Sam',
  })
  // No webhook reports back for email: accepted by Gmail is final.
  expect(await reload(email.id)).toMatchObject({
    status: 'sent',
    providerMessageId: '<abc@gmail.com>',
    attempts: 1,
  })
  expect(await sendDueMessages()).toBe(0) // never sent twice
})

it('tries a failed email again a minute later, and gives up after 3 tries', async () => {
  env.EMAIL_PROVIDER = 'smtp'
  const tenant = await createTenant('desert')
  const email = await queueEmail(tenant.id)
  vi.mocked(sendMail).mockRejectedValue(new Error('Connection timeout'))

  await sendDueMessages()
  expect(await reload(email.id)).toMatchObject({
    status: 'queued',
    attempts: 1,
    lastError: 'Connection timeout',
  })
  expect(await sendDueMessages()).toBe(0) // not due yet

  await makeDue(email.id)
  await sendDueMessages()
  await makeDue(email.id)
  await sendDueMessages()
  expect(await reload(email.id)).toMatchObject({ status: 'failed', attempts: 3 })
  expect(sendMail).toHaveBeenCalledTimes(3)
})

it('sends texts by text and emails by email', async () => {
  env.EMAIL_PROVIDER = 'smtp'
  const tenant = await shopWithPhone()
  const text = await queueText(tenant.id)
  const email = await queueEmail(tenant.id)
  vi.mocked(sendSms).mockResolvedValue('httpsms-id-1')
  vi.mocked(sendMail).mockResolvedValue('<abc@gmail.com>')

  expect(await sendDueMessages()).toBe(2)

  expect(sendSms).toHaveBeenCalledTimes(1)
  expect(sendSms).toHaveBeenCalledWith(expect.objectContaining({ requestId: text.id }))
  expect(sendMail).toHaveBeenCalledTimes(1)
  expect(await reload(email.id)).toMatchObject({ status: 'sent' })
})

it('only logs emails with EMAIL_PROVIDER=log', async () => {
  const tenant = await createTenant('desert')
  const email = await queueEmail(tenant.id)

  await sendDueMessages()

  expect(sendMail).not.toHaveBeenCalled()
  expect(await reload(email.id)).toMatchObject({ status: 'sent' })
})
```

- [ ] **Step 3: Run them to see them fail**

Run: `npx vitest run src/modules/messaging/sender.test.ts`
Expected: FAIL, `sendDueMessages` is not exported.

- [ ] **Step 4: Generalise the claim and add the email queries**

In `src/modules/messaging/messaging.queries.ts`, replace `claimDueTexts` with:

```ts
// Takes up to `limit` texts or emails that are due and counts a try on each. Pushing
// send_after a minute ahead is the lease: if the process dies mid-send, the message comes back
// then, and another instance skips rows this one has locked. Sign-in codes are sent by
// sendText() itself.
export function claimDue(channel: 'sms' | 'email', limit: number) {
  const due = db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.channel, channel),
        eq(messages.status, 'queued'),
        isNull(messages.providerMessageId),
        lte(messages.sendAfter, sql`now()`),
        ne(messages.kind, 'sign_in_code'),
      ),
    )
    .orderBy(messages.sendAfter)
    .limit(limit)
    .for('update', { skipLocked: true })
  return db
    .update(messages)
    .set({
      attempts: sql`${messages.attempts} + 1`,
      sendAfter: sql`now() + interval '1 minute'`,
    })
    .where(inArray(messages.id, due))
    .returning({
      id: messages.id,
      tenantId: messages.tenantId,
      contact: messages.contact,
      subject: messages.subject,
      body: messages.body,
      attempts: messages.attempts,
    })
}
```

Below `markLogged`:

```ts
// The email server took it. Email has no webhook, so this is final.
export async function markEmailSent(messageId: string, providerMessageId: string) {
  await db
    .update(messages)
    .set({ status: 'sent', providerMessageId, lastError: null })
    .where(eq(messages.id, messageId))
}
```

Beside `findSendingNumber`:

```ts
// Who an email is from: the contractor's name, with replies going to their own email.
export async function findEmailSender(tenantId: string) {
  const [tenant] = await db
    .select({ name: tenants.name, contactEmail: tenants.contactEmail })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
  return tenant
}
```

- [ ] **Step 5: Send emails from the loop**

In `src/modules/messaging/sender.ts`:

Update the header comment's first sentence to "The sender loop: every few seconds, texts and
emails that are due go to their provider." Import `sendMail`:

```ts
import { sendMail } from './smtp.ts'
```

Rename `TEXTS_PER_ROUND` to `PER_ROUND` (same value, 20, per channel). Change the comment on
`deliver` from `(claimDueTexts pushed it)` to `(claimDue pushed it)`. Add below `deliver`:

```ts
export type OutgoingEmail = {
  id: string
  tenantId: string
  contact: string
  subject: string
  body: string
}

// Hands one email to the SMTP server. Failures are retried like texts.
export async function deliverEmail(email: OutgoingEmail, lastTry: boolean) {
  if (env.EMAIL_PROVIDER === 'log') {
    logger.info({ messageId: email.id }, 'Email logged, not sent (EMAIL_PROVIDER=log)')
    if (env.NODE_ENV === 'development') {
      logger.info(
        { to: email.contact, subject: email.subject, body: email.body },
        'Development only: the email',
      )
    }
    await queries.markLogged(email.id)
    return
  }

  const sender = await queries.findEmailSender(email.tenantId)
  try {
    const providerId = await sendMail({
      fromName: sender.name,
      to: email.contact,
      replyTo: sender.contactEmail,
      subject: email.subject,
      text: email.body,
    })
    await queries.markEmailSent(email.id, providerId)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    logger.warn({ err: error, messageId: email.id, lastTry }, 'Email not sent')
    if (lastTry) await queries.markFailed(email.id, reason)
    else await queries.recordSendError(email.id, reason)
  }
}
```

Replace `sendDueTexts` with:

```ts
// One round: claims the due texts and sends them one by one, then the same for emails.
// Returns how many it took.
export async function sendDueMessages() {
  const texts = await queries.claimDue('sms', PER_ROUND)
  for (const text of texts) await deliver(text, text.attempts >= MESSAGE_MAX_ATTEMPTS)
  const emails = await queries.claimDue('email', PER_ROUND)
  for (const email of emails) {
    await deliverEmail(
      { ...email, subject: email.subject ?? '' },
      email.attempts >= MESSAGE_MAX_ATTEMPTS,
    )
  }
  return texts.length + emails.length
}
```

In `nextRound()`, change `round = sendDueTexts()` to `round = sendDueMessages()`.

- [ ] **Step 6: Run the messaging tests**

Run: `npx vitest run src/modules/messaging`
Expected: PASS (the old text tests and the new email ones).
Run: `npm run typecheck`
Expected: no errors. Search `rg "claimDueTexts|sendDueTexts" src` and expect no results.

- [ ] **Step 7: Write `docs/gmail-setup.md`**

````markdown
# Setting up Gmail for emails

How to make Relay send real emails (booking confirmations) from a Gmail account.

How the code works: `docs/superpowers/specs/2026-10-04-booking-confirmation-design.md`.

Without any of this, Relay runs with `EMAIL_PROVIDER=log`: nothing is sent, and each email is
printed in the `relay-api` terminal.

## 1. Make an app password (once)

Gmail doesn't let apps sign in with the account password. It gives each app its own password.

1. Use a Gmail account made for the demo, not a personal one: every email goes out from it.
2. Turn on 2-Step Verification: Google Account → Security → 2-Step Verification.
3. Open https://myaccount.google.com/apppasswords, type `Relay` as the name and click
   **Create**.
4. Copy the 16-letter password Google shows (`abcd efgh ijkl mnop`). You can't see it again.

## 2. Set up relay-api

In `relay-api/.env`:

```
EMAIL_PROVIDER=smtp
SMTP_USER=relay.demo@gmail.com
SMTP_PASS=abcd efgh ijkl mnop
```

`SMTP_HOST` and `SMTP_PORT` default to Gmail (`smtp.gmail.com`, `465`). Restart `npm run dev`.

## 3. Check it works

Book a visit on the booking page with your own email in the email field. Within a few seconds
the email arrives, from the contractor's name. Replying to it goes to the contractor's contact
email, not to the Gmail account.

If it doesn't arrive, look in the `messages` table:

```sql
select status, attempts, last_error from messages where channel = 'email' order by created_at desc limit 5;
```

- `Invalid login` / `Username and Password not accepted`: the app password is wrong, or
  2-Step Verification is off.
- `failed` after 3 tries: Gmail refused it three times, a minute apart. The reason is in
  `last_error`.
- `sent` but not in the inbox: check Spam and Promotions.

## Limits

- About 500 emails a day per Gmail account. Past that, Google stops sending for a day.
- Emails from a Gmail address carrying a business's name can land in spam. A sending domain
  (SPF, DKIM) fixes that later.
````

- [ ] **Step 8: Lint and commit**

Run: `npx biome check --write src/modules/messaging/messaging.queries.ts src/modules/messaging/sender.ts src/modules/messaging/sender.test.ts`

```bash
git add src/modules/messaging/messaging.queries.ts src/modules/messaging/sender.ts src/modules/messaging/sender.test.ts docs/gmail-setup.md
git commit -m "feat: send emails from the sender loop" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `bookVisit()` sends the confirmation

**Files:**
- Modify: `src/modules/booking/booking.queries.ts:23-31` (`findActiveService`)
- Modify: `src/modules/online-booking/online-booking.service.ts`
- Test: `src/modules/online-booking/online-booking.test.ts`

**Interfaces:**
- Consumes:
  - `textWindow`, `formatDay` from `src/lib/labels.ts` (Task 1)
  - `confirmationText`, `confirmationEmail`, `Confirmation` from `./confirmation.ts` (Task 1)
  - `sendEmail` from `../messaging/email.ts` (Task 2)
  - `sendText` from `../messaging/sms.ts`
- Produces: `checkServiceAndZip()` (private) now returns the service `{ id, name }`.

- [ ] **Step 1: Write the failing booking tests**

In `src/modules/online-booking/online-booking.test.ts`, add `messages` to the schema import
and `asc` to the `drizzle-orm` import (`import { asc, eq } from 'drizzle-orm'`). Inside
`describe('POST /api/online-booking/bookings', …)`, add:

```ts
  it('texts and emails the homeowner a confirmation', async () => {
    const shop = await createServingShop()

    const res = await post('bookings', bookingBody(shop)).expect(201)

    // 'email' sorts before 'sms'.
    const sent = await db.select().from(messages).orderBy(asc(messages.channel))
    expect(sent).toEqual([
      expect.objectContaining({
        channel: 'email',
        kind: 'booking_confirmation',
        status: 'queued',
        contact: 'sam@example.com',
        subject: 'Your visit is booked: Tue, Jan 8',
        jobId: res.body.jobId,
      }),
      expect.objectContaining({
        channel: 'sms',
        kind: 'booking_confirmation',
        status: 'queued',
        contact: '+14805550199',
        body: "desert HVAC: you're booked for AC repair on Tue, Jan 8, 8 AM - 12 PM at 4 Cactus Rd. Pay at the visit. Reply STOP to opt out.",
        jobId: res.body.jobId,
      }),
    ])
    expect(sent[0].customerId).toBe(sent[1].customerId)
    expect(sent[0].body).toContain('Address: 4 Cactus Rd, Mesa, AZ 85201')
    expect(sent[0].body).toContain('Questions? Call (480) 555-0100 or reply to this email.')
  })

  it('keeps the text from someone who didn’t agree to texts, and skips a blank email', async () => {
    const shop = await createServingShop()

    await post('bookings', bookingBody(shop, { consent: false, email: '' })).expect(201)

    expect(await db.select().from(messages)).toEqual([
      expect.objectContaining({
        channel: 'sms',
        kind: 'booking_confirmation',
        status: 'blocked',
        blockedReason: 'no_consent',
      }),
    ])
  })
```

And in the existing test `'never goes over the window’s cap, and doesn’t say how many jobs are
booked'`, add after the `toEqual` on `res.body.error`:

```ts
    // The refused booking saved no confirmation: only the two booked ones have theirs.
    expect(await db.select().from(messages)).toHaveLength(4)
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/modules/online-booking/online-booking.test.ts`
Expected: FAIL. No messages are saved (`[]`, and length 0 instead of 4).

- [ ] **Step 3: Return the service's name**

In `src/modules/booking/booking.queries.ts`, `findActiveService`:

```ts
    .select({ id: services.id, name: services.name })
```

- [ ] **Step 4: Send both from `bookVisit()`**

In `src/modules/online-booking/online-booking.service.ts`:

Imports. Change the labels import and add three more:

```ts
import { formatDay, formatWindow, textWindow } from '../../lib/labels.ts'
import { sendEmail } from '../messaging/email.ts'
import { type Confirmation, confirmationEmail, confirmationText } from './confirmation.ts'
```

Make `checkServiceAndZip` return the service:

```ts
async function checkServiceAndZip(tenantId: string, serviceId: string, zip: string, tx: Db) {
  const service = await booking.findActiveService(tenantId, serviceId, tx)
  if (!service) throw new HttpError(404, 'not_found', SERVICE_GONE)
  await checkZipServed(tenantId, zip, tx)
  return service
}
```

In `bookVisit()`, change the first line inside the transaction to:

```ts
    const service = await checkServiceAndZip(tenant.id, input.serviceId, input.zip, tx)
```

Then right after the `if (input.consent) { await recordConsent(…) }` block (the consent must
be saved first, since `sendText()` checks it), add:

```ts
    // The homeowner's confirmation, saved with the booking so a refused booking sends nothing.
    // sendText() blocks the text if they never agreed to texts.
    const confirmation: Confirmation = {
      tenantName: tenant.name,
      contactPhone: tenant.contactPhone,
      currency: tenant.currency,
      customerName: input.name,
      serviceName: service.name,
      dayLabel: formatDay(input.date),
      windowLabel: textWindow(slot.windowStartsAt, slot.windowEndsAt, tenant.timezone),
      street: input.street,
      unit: input.unit || null,
      city: input.city,
      state: input.state,
      zip: input.zip,
      priorityFeeCents,
    }
    const about = { kind: 'booking_confirmation' as const, jobId: job.id, customerId: customer.id }
    await sendText(
      tenant.id,
      { ...about, contact: input.phone, body: confirmationText(confirmation) },
      tx,
    )
    if (input.email) {
      await sendEmail(
        tenant.id,
        { ...about, contact: input.email, ...confirmationEmail(confirmation) },
        tx,
      )
    }
```

- [ ] **Step 5: Run the booking tests**

Run: `npx vitest run src/modules/online-booking`
Expected: PASS.

- [ ] **Step 6: Run everything**

Run: `npm run typecheck && npm test`
Expected: no type errors, every test passes.
Run: `npx biome check --write src/modules/booking/booking.queries.ts src/modules/online-booking/online-booking.service.ts src/modules/online-booking/online-booking.test.ts`
Then `npm run lint`. Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/modules/booking/booking.queries.ts src/modules/online-booking/online-booking.service.ts src/modules/online-booking/online-booking.test.ts
git commit -m "feat: text and email the homeowner a confirmation after booking online" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Manual check with the real Gmail account (with the user)

- [ ] Fill in `.env` as `docs/gmail-setup.md` says (the user provides the app password).
- [ ] `npm run dev` in `relay-api` and `relay-web`, book a visit at
      `http://desert.localhost:5173` with a real email.
- [ ] The email arrives from the contractor's name, and Reply-To is the contractor's contact
      email. The `messages` row is `sent`.
- [ ] With `SMS_PROVIDER=httpsms` and consent ticked, the confirmation text arrives on the
      phone.
