import { expect, it } from 'vitest'
import {
  type Confirmation,
  cancelledEmail,
  cancelledText,
  changedEmail,
  changedText,
  confirmationEmail,
  confirmationText,
  type VisitChange,
} from './confirmation.ts'

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
  manageUrl: 'https://desert.garified.com/manage/abc',
}

// Plain characters only: anything else switches a text to Unicode (70 characters per part).
const PLAIN = /^[\x20-\x7E]*$/

it('writes the confirmation text', () => {
  expect(confirmationText(booking)).toBe(
    "Desert Breeze Air: you're booked for AC Repair on Tue, Oct 6, 8 AM - 12 PM at 123 Main St. Pay at the visit. Change or cancel: https://desert.garified.com/manage/abc Reply STOP to opt out.",
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
      'Need to change or cancel? https://desert.garified.com/manage/abc',
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

const change: VisitChange = {
  tenantName: 'Rico’s Air',
  contactPhone: '+639171234567',
  customerName: 'Maria Lopez',
  dayLabel: 'Wed, Oct 7',
  windowLabel: '12 PM - 4 PM',
  address: '123 Main St, Phoenix, AZ 85001',
  link: 'https://rico.garified.com/manage/abc',
}

it('writes the moved text and email', () => {
  expect(changedText(change)).toBe(
    "Rico's Air: your visit is moved to Wed, Oct 7, 12 PM - 4 PM. Change or cancel: https://rico.garified.com/manage/abc",
  )
  expect(changedEmail(change)).toEqual({
    subject: 'Your visit is moved to Wed, Oct 7',
    body: [
      'Hi Maria,',
      '',
      'Your visit with Rico’s Air is moved.',
      '',
      'Arrival window: Wed, Oct 7, 12 PM - 4 PM',
      'Address: 123 Main St, Phoenix, AZ 85001',
      '',
      'Need to change or cancel again? https://rico.garified.com/manage/abc',
      '',
      'Questions? Call 0917 123 4567 or reply to this email.',
      '',
      'Rico’s Air',
    ].join('\n'),
  })
})

it('writes the cancelled text and email', () => {
  const cancelled = { ...change, link: 'https://rico.garified.com/' }
  expect(cancelledText(cancelled)).toBe(
    "Rico's Air: your visit on Wed, Oct 7 is cancelled. Book again: https://rico.garified.com/",
  )
  expect(cancelledEmail(cancelled)).toEqual({
    subject: 'Your visit on Wed, Oct 7 is cancelled',
    body: [
      'Hi Maria,',
      '',
      'Your visit with Rico’s Air on Wed, Oct 7, 12 PM - 4 PM is cancelled.',
      '',
      'To book another visit: https://rico.garified.com/',
      '',
      'Questions? Call 0917 123 4567 or reply to this email.',
      '',
      'Rico’s Air',
    ].join('\n'),
  })
})
