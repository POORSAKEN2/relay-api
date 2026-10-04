import nodemailer, { type Transporter } from 'nodemailer'
import { env } from '../../config/env.ts'

// Sends one email through SMTP (Gmail for the demo). Moving to a real email service later
// means replacing this one file.

let transport: Transporter | undefined

// Returns the email's Message-ID. Throws when the server refuses it or doesn't answer.
export async function sendMail(mail: {
  fromName: string // the contractor's name; the address is always the Gmail account's
  to: string
  replyTo: string // the contractor's own email, so replies reach them
  subject: string
  text: string
}) {
  transport ??= nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    // Every wait is capped at 10 seconds (nodemailer's defaults go up to 2 minutes).
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    dnsTimeout: 10_000,
    socketTimeout: 10_000,
  })
  const info = await transport.sendMail({
    from: { name: mail.fromName, address: env.SMTP_USER! },
    to: mail.to,
    replyTo: mail.replyTo,
    subject: mail.subject,
    text: mail.text,
  })
  return info.messageId
}
