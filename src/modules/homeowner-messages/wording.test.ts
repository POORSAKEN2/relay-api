import { expect, it } from 'vitest'
import {
  confirmationMessage,
  receiptMessage,
  reminderMessage,
  reviewRequestMessage,
} from './wording.ts'

const visit = {
  contractorName: 'Desert Breeze Air',
  customerName: ' Maria  Lopez ',
  serviceName: 'AC repair',
  date: '2030-01-08',
  localStart: '08:00:00',
  localEnd: '12:00:00',
}

const receipt = {
  number: 12,
  totalCents: 27800,
  currency: 'USD',
  lines: [
    { description: 'AC repair (diagnostic fee)', quantity: 1, totalCents: 8900 },
    { description: 'Capacitor', quantity: 2, totalCents: 18900 },
  ],
}

const messages = [
  confirmationMessage(visit),
  reminderMessage(visit),
  receiptMessage(visit, receipt),
  reviewRequestMessage(visit, 'https://g.page/r/desert/review'),
]

it('keeps every text to plain characters, so it costs 160 characters per SMS, not 70', () => {
  for (const message of messages) expect(message.text).toMatch(/^[\x20-\x7E]+$/)
})

it('greets the homeowner by first name and signs with the contractor’s name', () => {
  for (const message of messages) {
    expect(message.email.startsWith('Hi Maria,\n\n')).toBe(true)
    expect(message.email.endsWith('\n\nDesert Breeze Air')).toBe(true)
  }
})

it('confirms the visit with its day and arrival window', () => {
  expect(confirmationMessage(visit).text).toBe(
    "Desert Breeze Air: you're booked for AC repair on Tue, Jan 8, 8 AM-12 PM. We'll text you a reminder before the visit. Reply STOP to opt out.",
  )
})

it('lists what was paid for on the emailed receipt', () => {
  const { text, email } = receiptMessage(visit, receipt)
  expect(text).toBe(
    'Desert Breeze Air: thank you! We received your payment of $278.00. Receipt #12.',
  )
  expect(email).toContain(
    'Receipt #12\nAC repair (diagnostic fee): $89.00\nCapacitor x 2: $189.00\nTotal paid: $278.00',
  )
})
