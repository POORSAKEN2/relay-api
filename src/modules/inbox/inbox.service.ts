import { db } from '../../db/client.ts'
import { HttpError } from '../../lib/http-error.ts'
import * as audit from '../audit/audit.queries.ts'
import { findCustomerIdByPhone } from '../messaging/messaging.queries.ts'
import { sendText } from '../messaging/sms.ts'
import * as queries from './inbox.queries.ts'
import type { ReplyInput } from './inbox.schemas.ts'

// The office's SMS inbox: one thread per homeowner phone number, read and answered by hand.

const THREADS_SHOWN = 50
const MESSAGES_SHOWN = 100
const NO_THREAD = 'There are no texts with that number.'

export async function listThreads(tenantId: string) {
  const [rows, unreadTotal] = await Promise.all([
    queries.listThreads(tenantId, THREADS_SHOWN),
    queries.countUnread(tenantId),
  ])
  return {
    threads: rows.map((row) => ({
      contact: row.contact,
      customer: row.customer_id ? { id: row.customer_id, name: row.customer_name } : null,
      lastMessage: { body: row.body, direction: row.direction, createdAt: row.created_at },
      unread: row.unread,
    })),
    unreadTotal,
  }
}

// One thread's texts, oldest first, as a chat reads.
export async function getThread(tenantId: string, contact: string) {
  const rows = await queries.listThreadMessages(tenantId, contact, MESSAGES_SHOWN)
  if (rows.length === 0) throw new HttpError(404, 'not_found', NO_THREAD)
  return { messages: rows.reverse().map(toMessage) }
}

// Sends the office's answer through the same compliance gate as every other text: a reply to
// someone who texted STOP is saved as blocked, and returned that way for the screen to say so.
export async function reply(
  tenantId: string,
  user: { id: string; name: string },
  input: ReplyInput,
) {
  // Only threads the homeowner is already in: the inbox answers people, it doesn't cold-text.
  if (!(await queries.threadExists(tenantId, input.contact))) {
    throw new HttpError(404, 'not_found', NO_THREAD)
  }
  const message = await db.transaction(async (tx) => {
    const message = await sendText(
      tenantId,
      {
        contact: input.contact,
        kind: 'manual',
        body: input.body,
        sentByUserId: user.id,
        customerId: await findCustomerIdByPhone(tenantId, input.contact, tx),
      },
      tx,
    )
    // The body stays out of the audit log: the text itself is the record.
    await audit.insertUserAction(
      tenantId,
      {
        actorUserId: user.id,
        action: 'message.sent',
        entityType: 'message',
        entityId: message.id,
        data: { kind: 'manual' },
      },
      tx,
    )
    return message
  })
  return { message: toMessage({ ...message, sentByName: user.name }) }
}

export async function markRead(tenantId: string, contact: string) {
  await queries.markThreadRead(tenantId, contact)
}

function toMessage(row: {
  id: string
  direction: string
  kind: string
  body: string
  status: string
  blockedReason: string | null
  createdAt: Date
  sentByName: string | null
}) {
  return {
    id: row.id,
    direction: row.direction,
    kind: row.kind,
    body: row.body,
    status: row.status,
    blockedReason: row.blockedReason,
    createdAt: row.createdAt,
    sentBy: row.sentByName ? { name: row.sentByName } : null,
  }
}
