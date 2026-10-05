import { eq, sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTenant, resetDb } from '../../../test/helpers.ts'
import { env } from '../../config/env.ts'
import { db } from '../../db/client.ts'
import { messages, phoneNumbers } from '../../db/schema.ts'
import { sendEmail } from '../../lib/email.ts'
import { sendSms } from './httpsms.ts'
import { sendDueMessages } from './sender.ts'

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

describe('emails', () => {
  async function queueEmail(tenantId: string) {
    return queueText(tenantId, {
      channel: 'email',
      contact: 'maria@example.com',
      kind: 'booking_confirmation',
      subject: 'Your visit is booked',
      body: 'Hi Maria',
    })
  }

  it('sends a due email and counts it sent', async () => {
    const tenant = await createTenant('desert')
    const email = await queueEmail(tenant.id)

    expect(await sendDueMessages()).toBe(1)

    expect(sendEmail).toHaveBeenCalledWith({
      to: 'maria@example.com',
      subject: 'Your visit is booked',
      text: 'Hi Maria',
    })
    expect(sendSms).not.toHaveBeenCalled()
    expect(await reload(email.id)).toMatchObject({ status: 'sent', attempts: 1 })
  })

  it('tries a failed email again a minute later, and gives up after 3 tries', async () => {
    const tenant = await createTenant('desert')
    const email = await queueEmail(tenant.id)
    vi.mocked(sendEmail).mockRejectedValue(new Error('SMTP down'))

    await sendDueMessages()
    expect(await reload(email.id)).toMatchObject({ status: 'queued', lastError: 'SMTP down' })

    await makeDue(email.id)
    await sendDueMessages()
    await makeDue(email.id)
    await sendDueMessages()
    expect(await reload(email.id)).toMatchObject({ status: 'failed', attempts: 3 })
  })
})
