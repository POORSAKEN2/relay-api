import { expect, it } from 'vitest'
import { sendEmail } from './email.ts'

it('does nothing but log with EMAIL_PROVIDER=log (the test default)', async () => {
  await expect(
    sendEmail({ to: 'owner@example.com', subject: 'Hello', text: 'Hi' }),
  ).resolves.toBeUndefined()
})
