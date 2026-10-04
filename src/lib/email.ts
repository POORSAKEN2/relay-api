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
        connectionTimeout: 10_000,
        socketTimeout: 10_000,
      })
    : null

// Throws if the SMTP server doesn't take the email.
export async function sendEmail(email: { to: string; subject: string; text: string }) {
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
  await transport.sendMail({ from: env.EMAIL_FROM, ...email })
}
