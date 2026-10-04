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
