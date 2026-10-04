import { expect, it } from 'vitest'
import { type Confirmation, confirmationEmail, confirmationText } from './confirmation.ts'

const booking: Confirmation = {
  tenantName: 'Desert Breeze Air',
  contactPhone: '+639171234567',
  currency: 'USD',
  customerName: 'Maria Lopez',
  serviceName: 'AC Repair',
  dayLabel: 'Tue, Oct 6',
  windowLabel: '8 AM - 12 PM',
  street: '123 Main St',
  unit: null,
  city: 'Phoenix',
  state: 'AZ',
  zip: '85001',
  priorityFeeCents: 0,
}

// Plain characters only: anything else switches a text to Unicode (70 characters per part).
const PLAIN = /^[\x20-\x7E]*$/

it('writes the confirmation text', () => {
  expect(confirmationText(booking)).toBe(
    "Desert Breeze Air: you're booked for AC Repair on Tue, Oct 6, 8 AM - 12 PM at 123 Main St. Pay at the visit. Reply STOP to opt out.",
  )
  expect(confirmationText({ ...booking, unit: 'Unit 4' })).toContain('at 123 Main St, Unit 4.')
})

it('keeps the text plain when a name was typed with curly quotes or dashes', () => {
  const text = confirmationText({
    ...booking,
    tenantName: 'Rico’s Air – Cooling',
    serviceName: '“Tune-up”',
  })
  expect(text).toMatch(PLAIN)
  expect(text).toContain("Rico's Air - Cooling")
  expect(text).toContain('"Tune-up"')
})

it('writes the confirmation email', () => {
  expect(confirmationEmail(booking)).toEqual({
    subject: 'Your visit is booked: Tue, Oct 6',
    body: [
      'Hi Maria,',
      '',
      'Your visit with Desert Breeze Air is booked.',
      '',
      'Service: AC Repair',
      'Arrival window: Tue, Oct 6, 8 AM - 12 PM',
      'Address: 123 Main St, Phoenix, AZ 85001',
      '',
      "There's nothing to pay now. You pay the technician at the visit.",
      '',
      'Questions? Call 0917 123 4567 or reply to this email.',
      '',
      'Desert Breeze Air',
    ].join('\n'),
  })
})

it('adds the unit and the priority fee to the email when there are some', () => {
  const { body } = confirmationEmail({ ...booking, unit: 'Unit 4', priorityFeeCents: 4900 })
  expect(body).toContain('Address: 123 Main St, Unit 4, Phoenix, AZ 85001')
  expect(body).toContain('Priority service: $49.00, paid at the visit')
})
