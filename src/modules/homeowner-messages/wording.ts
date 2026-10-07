import { formatDay, formatMoney, formatWindow } from '../../lib/labels.ts'

// What the homeowner reads: each message as a text, and as an email's subject and body. Texts
// are short, start with the contractor's name, and use plain - and ' only: an en dash or a
// curly ’ makes the whole text Unicode, which fits 70 characters per SMS instead of 160.

export type Visit = {
  contractorName: string
  customerName: string
  serviceName: string
  date: string // local day, '2030-01-08'
  localStart: string // '08:00:00'
  localEnd: string
}

export type Receipt = {
  number: number
  totalCents: number
  currency: string
  lines: { description: string; quantity: number; totalCents: number }[]
}

export type Message = { text: string; subject: string; email: string }

// 'Tue, Jan 8, 8 AM-12 PM'
function when(visit: Visit): string {
  return `${formatDay(visit.date)}, ${formatWindow(visit.localStart, visit.localEnd).replace('–', '-')}`
}

function firstName(visit: Visit): string {
  return visit.customerName.trim().split(/\s+/)[0]
}

// "Hi Maria,", the paragraphs, then the contractor's name, a blank line between each.
function email(visit: Visit, ...paragraphs: string[]): string {
  return [`Hi ${firstName(visit)},`, ...paragraphs, visit.contractorName].join('\n\n')
}

// `manageUrl`: the homeowner's link to change or cancel, when the booking made one.
export function confirmationMessage(visit: Visit, manageUrl?: string): Message {
  const change = manageUrl ? ` Change or cancel: ${manageUrl}` : ''
  return {
    text: `${visit.contractorName}: you're booked for ${visit.serviceName} on ${when(visit)}. We'll text you a reminder before the visit.${change} Reply STOP to opt out.`,
    subject: `Your visit with ${visit.contractorName} is booked`,
    email: email(
      visit,
      `You're booked for ${visit.serviceName} on ${when(visit)}. Your technician will arrive during that window.`,
      `We'll remind you before the visit.`,
      ...(manageUrl ? [`Need to change or cancel? ${manageUrl}`] : []),
    ),
  }
}

// Sent a day and again two hours before the visit, with the same words.
export function reminderMessage(visit: Visit): Message {
  return {
    text: `${visit.contractorName}: reminder, your ${visit.serviceName} visit is ${when(visit)}. Reply STOP to opt out.`,
    subject: `Reminder: your visit with ${visit.contractorName}`,
    email: email(
      visit,
      `This is a reminder of your ${visit.serviceName} visit on ${when(visit)}. Your technician will arrive during that window.`,
    ),
  }
}

export function receiptMessage(visit: Visit, receipt: Receipt): Message {
  const money = (cents: number) => formatMoney(cents, receipt.currency)
  const lines = receipt.lines.map(
    (line) =>
      `${line.description}${line.quantity > 1 ? ` x ${line.quantity}` : ''}: ${money(line.totalCents)}`,
  )
  return {
    text: `${visit.contractorName}: thank you! We received your payment of ${money(receipt.totalCents)}. Receipt #${receipt.number}.`,
    subject: `Your receipt from ${visit.contractorName} (#${receipt.number})`,
    email: email(
      visit,
      `Thank you! We received your payment of ${money(receipt.totalCents)} for your visit on ${formatDay(visit.date)}.`,
      [`Receipt #${receipt.number}`, ...lines, `Total paid: ${money(receipt.totalCents)}`].join(
        '\n',
      ),
    ),
  }
}

export function reviewRequestMessage(visit: Visit, reviewUrl: string): Message {
  return {
    text: `${visit.contractorName}: thanks for having us. How did we do? Leave a review: ${reviewUrl} Reply STOP to opt out.`,
    subject: `How did we do, ${firstName(visit)}?`,
    email: email(
      visit,
      `Thanks for having us. If you have a minute, we'd love to hear how your visit went:`,
      reviewUrl,
    ),
  }
}
