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
