import nodemailer from 'nodemailer'
import { env } from '../config/env.ts'
import { logger } from './logger.ts'

// Every email Relay sends goes through here. The only file that talks to Gmail's SMTP server;
// replace it to change provider.

const transport =
  env.EMAIL_PROVIDER === 'smtp'
    ? nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_PORT === 465,
        auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD },
        // Every wait is capped at 10 seconds (nodemailer's defaults go up to 2 minutes).
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        dnsTimeout: 10_000,
        socketTimeout: 10_000,
      })
    : null

// Returns the email's Message-ID (undefined when only logged). Throws if the SMTP server
// doesn't take the email. A homeowner's email passes `fromName` (the contractor's name; the
// address is always the Gmail account's) and `replyTo` (the contractor's own email), so it
// reads as the contractor's and replies reach them. Others go from EMAIL_FROM.
export async function sendEmail(email: {
  to: string
  subject: string
  text: string
  fromName?: string
  replyTo?: string
}) {
  if (!transport) {
    logger.info({ to: email.to }, 'Email logged, not sent (EMAIL_PROVIDER=log)')
    // On a developer's machine the email is printed, so you can open an invite link.
    if (env.NODE_ENV === 'development') {
      logger.info(
        { to: email.to, subject: email.subject, text: email.text },
        'Development only: the email',
      )
    }
    return
  }
  const { fromName, ...rest } = email
  const from = fromName ? { name: fromName, address: env.SMTP_USER! } : env.EMAIL_FROM
  const info = await transport.sendMail({ from, ...rest })
  return info.messageId as string
}
