import { type Db, db } from '../../db/client.ts'
import { type MESSAGE_KINDS, messages } from '../../db/schema.ts'
import { logger } from '../../lib/logger.ts'

// TEMPORARY: this does not send anything. It saves the text as 'queued' and logs that it did,
// so the rest of the app can be built and tested. Before putting a real provider here, read
// docs/real-texting-todo.md: the consent check, STOP replies and quiet hours all belong in
// this function.
export async function sendText(
  tenantId: string,
  text: { contact: string; kind: (typeof MESSAGE_KINDS)[number]; body: string },
  tx: Db = db,
) {
  const [message] = await tx
    .insert(messages)
    .values({ tenantId, channel: 'sms', direction: 'outbound', status: 'queued', ...text })
    .returning({ id: messages.id })
  logger.info(
    { tenantId, messageId: message.id, kind: text.kind },
    'Text saved, not sent: real texting isn’t built yet',
  )
}
