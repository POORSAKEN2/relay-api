import { formatMoney, formatPhone } from '../../lib/labels.ts'

// What the homeowner is told by text and email about their visit: the confirmation right
// after booking online, and the news when they move or cancel it from their link.
// Pure, so the words are tested without a database.

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
  manageUrl: string // the link to change or cancel the visit
}

// Curly quotes and dashes typed into a name would switch the whole text to Unicode.
export function plainText(text: string): string {
  return text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
}

export function confirmationText(v: Confirmation): string {
  const street = v.unit ? `${v.street}, ${v.unit}` : v.street
  return plainText(
    `${v.tenantName}: you're booked for ${v.serviceName} on ${v.dayLabel}, ${v.windowLabel} at ${street}. Pay at the visit. Change or cancel: ${v.manageUrl} Reply STOP to opt out.`,
  )
}

export function confirmationEmail(v: Confirmation): { subject: string; body: string } {
  const priority =
    v.priorityFeeCents > 0
      ? [`Priority service: ${formatMoney(v.priorityFeeCents, v.currency)}, paid at the visit`]
      : []
  const body = [
    `Hi ${firstName(v.customerName)},`,
    '',
    `Your visit with ${v.tenantName} is booked.`,
    '',
    `Service: ${v.serviceName}`,
    `Arrival window: ${v.dayLabel}, ${v.windowLabel}`,
    `Address: ${addressLine(v)}`,
    ...priority,
    '',
    "There's nothing to pay now. You pay the technician at the visit.",
    '',
    `Need to change or cancel? ${v.manageUrl}`,
    ...signOff(v),
  ]
  return { subject: `Your visit is booked: ${v.dayLabel}`, body: body.join('\n') }
}

// '123 Main St, Unit 4, Phoenix, AZ 85001'; the unit is left out when there is none.
export function addressLine(a: {
  street: string
  unit: string | null
  city: string
  state: string
  zip: string
}): string {
  return [a.street, a.unit, a.city, `${a.state} ${a.zip}`].filter(Boolean).join(', ')
}

// What the homeowner is told after moving or cancelling from their link. `link` is the same
// manage link (moved) or the booking page (cancelled).
export type VisitChange = {
  tenantName: string
  contactPhone: string // the contractor's, E.164
  customerName: string
  dayLabel: string // 'Wed, Oct 7'
  windowLabel: string // '12 PM - 4 PM' (textWindow)
  address: string // addressLine()
  link: string
}

export function changedText(v: VisitChange): string {
  return plainText(
    `${v.tenantName}: your visit is moved to ${v.dayLabel}, ${v.windowLabel}. Change or cancel: ${v.link}`,
  )
}

export function changedEmail(v: VisitChange): { subject: string; body: string } {
  const body = [
    `Hi ${firstName(v.customerName)},`,
    '',
    `Your visit with ${v.tenantName} is moved.`,
    '',
    `Arrival window: ${v.dayLabel}, ${v.windowLabel}`,
    `Address: ${v.address}`,
    '',
    `Need to change or cancel again? ${v.link}`,
    ...signOff(v),
  ]
  return { subject: `Your visit is moved to ${v.dayLabel}`, body: body.join('\n') }
}

export function cancelledText(v: VisitChange): string {
  return plainText(
    `${v.tenantName}: your visit on ${v.dayLabel} is cancelled. Book again: ${v.link}`,
  )
}

export function cancelledEmail(v: VisitChange): { subject: string; body: string } {
  const body = [
    `Hi ${firstName(v.customerName)},`,
    '',
    `Your visit with ${v.tenantName} on ${v.dayLabel}, ${v.windowLabel} is cancelled.`,
    '',
    `To book another visit: ${v.link}`,
    ...signOff(v),
  ]
  return { subject: `Your visit on ${v.dayLabel} is cancelled`, body: body.join('\n') }
}

function firstName(name: string) {
  return name.split(' ')[0]
}

// The end of every email: how to reach the contractor, and their name.
function signOff(v: { tenantName: string; contactPhone: string }) {
  return [
    '',
    `Questions? Call ${formatPhone(v.contactPhone)} or reply to this email.`,
    '',
    v.tenantName,
  ]
}
