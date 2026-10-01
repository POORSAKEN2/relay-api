import { env } from '../../config/env.ts'
import { type Db, db } from '../../db/client.ts'
import { type MESSAGE_KINDS, messages } from '../../db/schema.ts'
import { logger } from '../../lib/logger.ts'

// TEMPORARY: this does not send anything. It saves the text as 'queued' and logs that it did,
// so the rest of the app can be built and tested. Before putting a real provider here, read
// docs/real-texting-todo.md: the consent check, STOP replies and quiet hours all belong in
// this function.
export async function sendText(
  tenantId: string,
  text: {
    contact: string
    kind: (typeof MESSAGE_KINDS)[number]
    body: string
    toUserId?: string // the staff member or technician it goes to
    jobId?: string // the job it is about
    customerId?: string // the homeowner it goes to
  },
  tx: Db = db,
) {
  // A sign-in code is never stored: anyone who can read messages could sign in with it.
  const body = text.kind === 'sign_in_code' ? 'Sign-in code (not stored)' : text.body
  const [message] = await tx
    .insert(messages)
    .values({ tenantId, channel: 'sms', direction: 'outbound', status: 'queued', ...text, body })
    .returning({ id: messages.id })
  logger.info(
    { tenantId, messageId: message.id, kind: text.kind },
    'Text saved, not sent: real texting isn’t built yet',
  )
  // On a developer's machine the text is printed instead, so you can read a sign-in code.
  if (env.NODE_ENV === 'development') {
    logger.info(
      { to: text.contact, body: text.body },
      'Development only: the text that would be sent',
    )
  }
}
