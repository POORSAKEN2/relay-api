import { eq, sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTenant, resetDb } from '../../../test/helpers.ts'
import { env } from '../../config/env.ts'
import { db } from '../../db/client.ts'
import { messages, phoneNumbers } from '../../db/schema.ts'
import { sendEmail } from '../../lib/email.ts'
import { sendSms } from './httpsms.ts'
import { sendDueMessages, startSender, stopSender } from './sender.ts'

vi.mock('./httpsms.ts', () => ({ sendSms: vi.fn() }))
vi.mock('../../lib/email.ts', () => ({ sendEmail: vi.fn() }))

const SENDING_NUMBER = '+639170000000'

beforeEach(async () => {
  await resetDb()
  vi.mocked(sendSms).mockReset()
  vi.mocked(sendEmail).mockReset()
  env.SMS_PROVIDER = 'httpsms'
})
afterEach(() => {
  env.SMS_PROVIDER = 'log'
})

async function shopWithPhone() {
  const tenant = await createTenant('desert')
  await db.insert(phoneNumbers).values({ tenantId: tenant.id, number: SENDING_NUMBER })
  return tenant
}

async function queueText(tenantId: string, values: Partial<typeof messages.$inferInsert> = {}) {
  const [text] = await db
    .insert(messages)
    .values({
      tenantId,
      channel: 'sms',
      direction: 'outbound',
      status: 'queued',
      contact: '+639171234567',
      kind: 'on_my_way',
      body: 'On my way',
      ...values,
    })
    .returning()
  return text
}

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

async function reload(id: string) {
  const [text] = await db.select().from(messages).where(eq(messages.id, id))
  return text
}

// Makes a text due again, as if its minute had passed.
async function makeDue(id: string) {
  await db
    .update(messages)
    .set({ sendAfter: sql`now() - interval '1 second'` })
    .where(eq(messages.id, id))
}

it('hands a due text to httpSMS from the contractor’s number', async () => {
  const tenant = await shopWithPhone()
  const text = await queueText(tenant.id)
  vi.mocked(sendSms).mockResolvedValue('httpsms-id-1')

  expect(await sendDueMessages()).toBe(1)

  expect(sendSms).toHaveBeenCalledWith({
    from: SENDING_NUMBER,
    to: '+639171234567',
    content: 'On my way',
    requestId: text.id,
  })
  // Still queued: the phone hasn't reported it sent yet.
  expect(await reload(text.id)).toMatchObject({
    status: 'queued',
    providerMessageId: 'httpsms-id-1',
    attempts: 1,
  })
  expect(await sendDueMessages()).toBe(0) // never sent twice
})

it('tries a failed text again a minute later, and gives up after 3 tries', async () => {
  const tenant = await shopWithPhone()
  const text = await queueText(tenant.id)
  vi.mocked(sendSms).mockRejectedValue(new Error('httpSMS answered 500: down'))

  await sendDueMessages()
  const first = await reload(text.id)
  expect(first).toMatchObject({
    status: 'queued',
    attempts: 1,
    lastError: 'httpSMS answered 500: down',
  })
  expect(first.sendAfter.getTime()).toBeGreaterThan(Date.now() + 50_000)
  expect(await sendDueMessages()).toBe(0) // not due yet

  await makeDue(text.id)
  await sendDueMessages()
  await makeDue(text.id)
  await sendDueMessages()
  expect(await reload(text.id)).toMatchObject({ status: 'failed', attempts: 3 })
  expect(sendSms).toHaveBeenCalledTimes(3)
})

it('fails a text when the contractor has no sending number', async () => {
  const tenant = await createTenant('desert')
  const text = await queueText(tenant.id)

  await sendDueMessages()

  expect(sendSms).not.toHaveBeenCalled()
  expect(await reload(text.id)).toMatchObject({
    status: 'failed',
    lastError: 'The contractor has no active sending number',
  })
})

it('leaves blocked texts, texts held for later and sign-in codes alone', async () => {
  const tenant = await shopWithPhone()
  await queueText(tenant.id, { status: 'blocked', blockedReason: 'no_consent' })
  await queueText(tenant.id, { sendAfter: new Date(Date.now() + 3_600_000) })
  await queueText(tenant.id, { kind: 'sign_in_code', body: 'Sign-in code (not stored)' })

  expect(await sendDueMessages()).toBe(0)
  expect(sendSms).not.toHaveBeenCalled()
})

it('only logs texts with SMS_PROVIDER=log', async () => {
  env.SMS_PROVIDER = 'log'
  const tenant = await createTenant('desert')
  const text = await queueText(tenant.id)

  await sendDueMessages()

  expect(sendSms).not.toHaveBeenCalled()
  expect(await reload(text.id)).toMatchObject({ status: 'sent' })
})

it('sends a due email as the contractor, with replies going to the contractor', async () => {
  const tenant = await createTenant('desert')
  const email = await queueEmail(tenant.id)
  vi.mocked(sendEmail).mockResolvedValue('<abc@gmail.com>')

  expect(await sendDueMessages()).toBe(1)

  expect(sendEmail).toHaveBeenCalledWith({
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
  const tenant = await createTenant('desert')
  const email = await queueEmail(tenant.id)
  vi.mocked(sendEmail).mockRejectedValue(new Error('Connection timeout'))

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
  expect(sendEmail).toHaveBeenCalledTimes(3)
})

it('sends texts by text and emails by email', async () => {
  const tenant = await shopWithPhone()
  const text = await queueText(tenant.id)
  const email = await queueEmail(tenant.id)
  vi.mocked(sendSms).mockResolvedValue('httpsms-id-1')
  vi.mocked(sendEmail).mockResolvedValue('<abc@gmail.com>')

  expect(await sendDueMessages()).toBe(2)

  expect(sendSms).toHaveBeenCalledTimes(1)
  expect(sendSms).toHaveBeenCalledWith(expect.objectContaining({ requestId: text.id }))
  expect(sendEmail).toHaveBeenCalledTimes(1)
  expect(await reload(email.id)).toMatchObject({ status: 'sent' })
})

it('keeps sending texts while Gmail is stuck on an email', async () => {
  const tenant = await shopWithPhone()
  await queueEmail(tenant.id)
  let answerGmail = (_id: string) => {}
  vi.mocked(sendEmail).mockReturnValue(new Promise((resolve) => (answerGmail = resolve)))
  vi.mocked(sendSms).mockResolvedValue('httpsms-id-1')

  startSender()
  try {
    await vi.waitFor(() => expect(sendEmail).toHaveBeenCalled())
    // A missed-call text-back written while the email hangs still leaves within a round.
    const text = await queueText(tenant.id)
    await vi.waitFor(
      async () => expect((await reload(text.id)).providerMessageId).toBe('httpsms-id-1'),
      { timeout: 8_000, interval: 200 },
    )
  } finally {
    answerGmail('<abc@gmail.com>')
    await stopSender()
  }
}, 15_000)

it('fails a message whose last try never finished, and keeps sending the rest', async () => {
  const tenant = await shopWithPhone()
  // The process died during this text's 3rd try: still queued, and due again.
  const stuck = await queueText(tenant.id, { attempts: 3 })
  const next = await queueText(tenant.id)
  vi.mocked(sendSms).mockResolvedValue('httpsms-id-1')

  await sendDueMessages()

  expect(await reload(stuck.id)).toMatchObject({
    status: 'failed',
    attempts: 3,
    lastError: 'Stopped during its last try',
  })
  expect(await reload(next.id)).toMatchObject({ providerMessageId: 'httpsms-id-1' })
  expect(sendSms).toHaveBeenCalledTimes(1)
})

describe('quiet hours', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function at(time: string) {
    vi.setSystemTime(new Date(`2030-01-08T${time}-07:00`))
  }

  it('holds a reminder at 23:00 until 08:00 without counting a try', async () => {
    const tenant = await shopWithPhone()
    at('23:00:00')
    const text = await queueText(tenant.id, { kind: 'reminder' })

    await sendDueMessages()

    expect(sendSms).not.toHaveBeenCalled()
    expect(await reload(text.id)).toMatchObject({
      status: 'queued',
      attempts: 0,
      sendAfter: new Date('2030-01-09T08:00:00-07:00'),
    })
  })

  it('holds a reminder on attempts: 2 without failing it', async () => {
    const tenant = await shopWithPhone()
    at('23:00:00')
    const text = await queueText(tenant.id, { kind: 'reminder', attempts: 2 })

    await sendDueMessages()

    expect(sendSms).not.toHaveBeenCalled()
    expect(await reload(text.id)).toMatchObject({
      status: 'queued',
      attempts: 2,
    })
  })

  it('hands on_my_way and job_assigned over at 23:00', async () => {
    const tenant = await shopWithPhone()
    at('23:00:00')
    await queueText(tenant.id, { kind: 'on_my_way' })
    await queueText(tenant.id, { kind: 'job_assigned' })

    await sendDueMessages()

    expect(sendSms).toHaveBeenCalledTimes(2)
  })

  it('holds new_booking_alert at 23:00 until 08:00', async () => {
    const tenant = await shopWithPhone()
    at('23:00:00')
    const text = await queueText(tenant.id, { kind: 'new_booking_alert' })

    await sendDueMessages()

    expect(sendSms).not.toHaveBeenCalled()
    expect(await reload(text.id)).toMatchObject({
      status: 'queued',
      attempts: 0,
      sendAfter: new Date('2030-01-09T08:00:00-07:00'),
    })
  })

  it('sends an email with kind reminder at 23:00', async () => {
    const tenant = await createTenant('desert')
    at('23:00:00')
    const email = await queueText(tenant.id, {
      channel: 'email',
      contact: 'maria@example.com',
      kind: 'reminder',
      subject: 'Reminder',
      body: 'See you tomorrow',
    })

    await sendDueMessages()

    expect(sendEmail).toHaveBeenCalled()
    expect(await reload(email.id)).toMatchObject({ status: 'sent' })
  })

  it('hands a reminder over at 14:00', async () => {
    const tenant = await shopWithPhone()
    at('14:00:00')
    await queueText(tenant.id, { kind: 'reminder' })

    await sendDueMessages()

    expect(sendSms).toHaveBeenCalledTimes(1)
  })
})
