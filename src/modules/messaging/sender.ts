import * as Sentry from '@sentry/node'
import { env } from '../../config/env.ts'
import { MESSAGE_MAX_ATTEMPTS } from '../../db/schema.ts'
import { sendEmail } from '../../lib/email.ts'
import { logger } from '../../lib/logger.ts'
import { sendSms } from './httpsms.ts'
import * as queries from './messaging.queries.ts'

// The sender loop: every few seconds, texts and emails that are due go out. sendText() and
// queueEmail() only save them, inside the caller's transaction, so nothing leaves for a change
// that was rolled back. Not a pg-boss cron: those run once a minute at most, and a missed-call
// text-back must leave within 30 seconds.

const ROUND_MS = 5_000
const MESSAGES_PER_ROUND = 20

export type OutgoingText = { id: string; tenantId: string; contact: string; body: string }
type OutgoingEmail = { id: string; contact: string; subject: string | null; body: string }

// Hands one text to the provider and records what happened. On a failure the text is tried
// again a minute later (claimDueMessages pushed it), unless this was its last try.
export async function deliver(text: OutgoingText, lastTry: boolean) {
  if (env.SMS_PROVIDER === 'log') {
    logger.info({ messageId: text.id }, 'Text logged, not sent (SMS_PROVIDER=log)')
    // On a developer's machine the text is printed, so you can read a sign-in code.
    if (env.NODE_ENV === 'development') {
      logger.info({ to: text.contact, body: text.body }, 'Development only: the text')
    }
    await queries.markSent(text.id)
    return
  }

  const from = await queries.findSendingNumber(text.tenantId)
  if (!from) {
    await queries.markFailed(text.id, 'The contractor has no active sending number')
    return
  }
  try {
    const providerId = await sendSms({
      from,
      to: text.contact,
      content: text.body,
      requestId: text.id,
    })
    await queries.markHandedOver(text.id, providerId)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    logger.warn({ err: error, messageId: text.id, lastTry }, 'Text not handed to httpSMS')
    if (lastTry) await queries.markFailed(text.id, reason)
    else await queries.recordSendError(text.id, reason)
  }
}

// Hands one email to the SMTP server. Failures are retried like a text's.
async function deliverEmail(email: OutgoingEmail, lastTry: boolean) {
  try {
    await sendEmail({ to: email.contact, subject: email.subject ?? '', text: email.body })
    await queries.markSent(email.id)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    logger.warn({ err: error, messageId: email.id, lastTry }, 'Email not sent')
    if (lastTry) await queries.markFailed(email.id, reason)
    else await queries.recordSendError(email.id, reason)
  }
}

// One round: claims the due texts and emails and sends them one by one. Returns how many it
// took.
export async function sendDueMessages() {
  const due = await queries.claimDueMessages(MESSAGES_PER_ROUND)
  for (const message of due) {
    const lastTry = message.attempts >= MESSAGE_MAX_ATTEMPTS
    if (message.channel === 'email') await deliverEmail(message, lastTry)
    else await deliver(message, lastTry)
  }
  return due.length
}

let running = false
let timer: NodeJS.Timeout | undefined
let round: Promise<void> = Promise.resolve()

// The next round starts 5 seconds after this one ends, so two never overlap.
function nextRound() {
  round = sendDueMessages()
    .then(
      () => undefined,
      (error) => {
        logger.error({ err: error }, 'Sender round failed')
        Sentry.captureException(error)
      },
    )
    .then(() => {
      if (running) timer = setTimeout(nextRound, ROUND_MS)
    })
}

export function startSender() {
  running = true
  nextRound()
}

// Lets the round in flight finish, so no text is left half-sent.
export async function stopSender() {
  running = false
  clearTimeout(timer)
  await round
}
