import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createTenant, resetDb } from '../../../test/helpers.ts'
import { db } from '../../db/client.ts'
import { consentEvents, messages } from '../../db/schema.ts'
import { sendText } from './sms.ts'

const PHONE = '+639171234567'

beforeEach(resetDb)
afterEach(() => {
  vi.useRealTimers()
})

async function consent(tenantId: string, granted: boolean) {
  await db
    .insert(consentEvents)
    .values({ tenantId, contact: PHONE, channel: 'sms', granted, source: 'booking_form' })
}

async function savedText() {
  const [text] = await db.select().from(messages)
  return text
}

it('blocks a homeowner text when they never agreed to texts', async () => {
  const tenant = await createTenant('desert')
  await sendText(tenant.id, { contact: PHONE, kind: 'on_my_way', body: 'On my way' })
  expect(await savedText()).toMatchObject({ status: 'blocked', blockedReason: 'no_consent' })
})

it('queues a homeowner text once they agreed', async () => {
  const tenant = await createTenant('desert')
  await consent(tenant.id, true)
  await sendText(tenant.id, { contact: PHONE, kind: 'on_my_way', body: 'On my way' })
  expect(await savedText()).toMatchObject({ status: 'queued', blockedReason: null, attempts: 0 })
})

it('blocks everything after a STOP, even a reply to their call', async () => {
  const tenant = await createTenant('desert')
  await consent(tenant.id, true)
  await consent(tenant.id, false)
  await sendText(tenant.id, { contact: PHONE, kind: 'text_back', body: 'Sorry we missed you' })
  expect(await savedText()).toMatchObject({ status: 'blocked', blockedReason: 'opted_out' })
})

it('replies to a missed caller who never filled in the form', async () => {
  const tenant = await createTenant('desert')
  await sendText(tenant.id, { contact: PHONE, kind: 'text_back', body: 'Sorry we missed you' })
  expect(await savedText()).toMatchObject({ status: 'queued' })
})

it('never checks consent for staff texts', async () => {
  const tenant = await createTenant('desert')
  await sendText(tenant.id, { contact: PHONE, kind: 'job_assigned', body: 'New job' })
  expect(await savedText()).toMatchObject({ status: 'queued' })
})

it('holds unprompted texts until quiet hours end, but not visit texts', async () => {
  const tenant = await createTenant('desert') // Phoenix, quiet 21:00 to 08:00
  await consent(tenant.id, true)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2030-01-08T23:00:00-07:00'))

  await sendText(tenant.id, { contact: PHONE, kind: 'reminder', body: 'See you tomorrow' })
  expect((await savedText()).sendAfter).toEqual(new Date('2030-01-09T08:00:00-07:00'))

  await db.delete(messages)
  await sendText(tenant.id, { contact: PHONE, kind: 'on_my_way', body: 'On my way' })
  expect((await savedText()).sendAfter.getTime()).toBeLessThan(Date.parse('2030-01-09'))
})

it('never holds staff texts or replies even at night', async () => {
  const tenant = await createTenant('desert')
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2030-01-08T23:00:00-07:00'))

  await sendText(tenant.id, { contact: PHONE, kind: 'job_assigned', body: 'New job' })
  expect((await savedText()).sendAfter.getTime()).toBeLessThan(Date.parse('2030-01-09'))

  await db.delete(messages)
  await consent(tenant.id, true)
  await sendText(tenant.id, { contact: PHONE, kind: 'text_back', body: 'Sorry we missed you' })
  expect((await savedText()).sendAfter.getTime()).toBeLessThan(Date.parse('2030-01-09'))
})

it('sends a sign-in code at once and never stores it', async () => {
  const tenant = await createTenant('desert')
  await sendText(tenant.id, { contact: PHONE, kind: 'sign_in_code', body: 'Your code is 123456' })
  expect(await savedText()).toMatchObject({
    status: 'sent', // SMS_PROVIDER=log in tests
    body: 'Sign-in code (not stored)',
  })
})
