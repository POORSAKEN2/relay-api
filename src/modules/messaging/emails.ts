import { type Db, db } from '../../db/client.ts'
import * as queries from './messaging.queries.ts'
import type { MessageKind } from './rules.ts'

// Every email to a homeowner starts here. Like sendText(), it only saves the email, in the
// caller's transaction; the sender loop (sender.ts) sends it a few seconds later. The texting
// rules don't apply: an email about the homeowner's own visit needs no consent, and nobody is
// woken by one at night.
export async function queueEmail(
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
  await queries.insertMessage(
    { tenantId, channel: 'email', direction: 'outbound', status: 'queued', ...email },
    tx,
  )
}
