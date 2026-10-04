import { formatMoney, formatPhone } from '../../lib/labels.ts'

// What the homeowner is told right after booking online: one text and, when they gave an
// email, one email. Pure, so the words are tested without a database.

export type Confirmation = {
  tenantName: string
  contactPhone: string // the contractor's, E.164
  currency: string
  customerName: string
  serviceName: string
  dayLabel: string // 'Tue, Oct 6' (formatDay)
  windowLabel: string // '8 AM - 12 PM' (textWindow)
  street: string
  unit: string | null
  city: string
  state: string
  zip: string
  priorityFeeCents: number
}

// Curly quotes and dashes typed into a name would switch the whole text to Unicode.
export function plainText(text: string): string {
  return text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
}

export function confirmationText(v: Confirmation): string {
  const street = v.unit ? `${v.street}, ${v.unit}` : v.street
  return plainText(
    `${v.tenantName}: you're booked for ${v.serviceName} on ${v.dayLabel}, ${v.windowLabel} at ${street}. Pay at the visit. Reply STOP to opt out.`,
  )
}

export function confirmationEmail(v: Confirmation): { subject: string; body: string } {
  const firstName = v.customerName.split(' ')[0]
  const address = [v.street, v.unit, v.city, `${v.state} ${v.zip}`].filter(Boolean).join(', ')
  const priority =
    v.priorityFeeCents > 0
      ? [`Priority service: ${formatMoney(v.priorityFeeCents, v.currency)}, paid at the visit`]
      : []
  const body = [
    `Hi ${firstName},`,
    '',
    `Your visit with ${v.tenantName} is booked.`,
    '',
    `Service: ${v.serviceName}`,
    `Arrival window: ${v.dayLabel}, ${v.windowLabel}`,
    `Address: ${address}`,
    ...priority,
    '',
    "There's nothing to pay now. You pay the technician at the visit.",
    '',
    `Questions? Call ${formatPhone(v.contactPhone)} or reply to this email.`,
    '',
    v.tenantName,
  ]
  return { subject: `Your visit is booked: ${v.dayLabel}`, body: body.join('\n') }
}
