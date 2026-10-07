import { expect, it } from 'vitest'
import {
  cancelledEmail,
  cancelledText,
  changedEmail,
  changedText,
  type VisitChange,
} from './confirmation.ts'

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

// Plain characters only: anything else switches a text to Unicode (70 characters per part).
const PLAIN = /^[\x20-\x7E]*$/

it('keeps the text plain when a name was typed with curly quotes or dashes', () => {
  const text = changedText({ ...change, tenantName: 'Rico’s Air – Cooling' })
  expect(text).toMatch(PLAIN)
  expect(text).toContain("Rico's Air - Cooling")
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
