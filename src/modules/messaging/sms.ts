import { type Db, db } from '../../db/client.ts'
import { MESSAGE_MAX_ATTEMPTS } from '../../db/schema.ts'
import * as queries from './messaging.queries.ts'
import { endOfQuietHours } from './quiet-hours.ts'
import { type MessageKind, TEXT_RULES } from './rules.ts'
import { deliver } from './sender.ts'

// Every text Relay sends starts here. It applies the rules (consent, quiet hours) and saves the
// text in the caller's transaction, so the change and its text are saved together or not at
// all. It never calls the network: the sender loop (sender.ts) sends saved texts a few seconds
// later. The one exception is a sign-in code, sent right away (see below).
export async function sendText(
  tenantId: string,
  text: {
    contact: string
    kind: MessageKind
    body: string
    toUserId?: string // the staff member or technician it goes to
    jobId?: string // the job it is about
    customerId?: string // the homeowner it goes to
    callId?: string // the missed call a text-back answers
  },
  tx: Db = db,
) {
  const rule = TEXT_RULES[text.kind]
  const blockedReason = await consentProblem(tenantId, text.contact, rule.consent, tx)
  const sendAfter = rule.quietHours && !blockedReason ? await endOfQuietHours(tenantId, tx) : null

  // A sign-in code is never stored: anyone who can read messages could sign in with it.
  const isCode = text.kind === 'sign_in_code'
  const message = await queries.insertMessage(
    {
      tenantId,
      channel: 'sms',
      direction: 'outbound',
      status: blockedReason ? 'blocked' : 'queued',
      blockedReason,
      ...text,
      body: isCode ? 'Sign-in code (not stored)' : text.body,
      ...(sendAfter ? { sendAfter } : {}),
      // One try only: the loop can't retry a code it never saw.
      ...(isCode ? { attempts: MESSAGE_MAX_ATTEMPTS } : {}),
    },
    tx,
  )

  // The sign-in route uses no transaction, so the row is already saved: send the real code now.
  if (isCode && !blockedReason) {
    await deliver({ id: message.id, tenantId, contact: text.contact, body: text.body }, true)
  }
}

// Why the homeowner can't be texted, or null if they can. An opt-out (STOP) always wins.
async function consentProblem(
  tenantId: string,
  contact: string,
  consent: 'required' | 'opt_out' | 'none',
  tx: Db,
) {
  if (consent === 'none') return null
  const latest = await queries.findLatestConsent(tenantId, contact, tx)
  if (latest?.granted === false) return 'opted_out' as const
  if (!latest && consent === 'required') return 'no_consent' as const
  return null
}
