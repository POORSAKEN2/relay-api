import { expect, it } from 'vitest'
import { formatClock, formatDate, formatMoney, formatPhone, textWindow } from './labels.ts'

it('shows a moment as the contractor’s wall clock', () => {
  expect(formatClock(new Date('2030-01-08T16:10:00Z'), 'America/Phoenix')).toBe('9:10 AM')
  expect(formatClock(new Date('2030-01-08T19:00:00Z'), 'America/Phoenix')).toBe('12 PM')
  // Daylight saving time: Los Angeles is UTC-7 in July.
  expect(formatClock(new Date('2030-07-08T16:10:00Z'), 'America/Los_Angeles')).toBe('9:10 AM')
})

it('writes a day with its year, for history', () => {
  expect(formatDate('2030-01-08')).toBe('Jan 8, 2030')
  expect(formatDate('2026-09-12')).toBe('Sep 12, 2026')
})

it('writes a window for a text, with a plain hyphen', () => {
  // Phoenix is UTC-7 all year.
  const start = new Date('2030-01-08T15:00:00Z')
  const end = new Date('2030-01-08T19:00:00Z')
  expect(textWindow(start, end, 'America/Phoenix')).toBe('8 AM - 12 PM')
})

it('shows a phone the way people write it', () => {
  expect(formatPhone('+639171234567')).toBe('0917 123 4567')
  expect(formatPhone('+14805550100')).toBe('(480) 555-0100')
  expect(formatPhone('+442071234567')).toBe('+442071234567')
})

it('writes an amount of money in the contractor’s currency', () => {
  expect(formatMoney(18900, 'USD')).toBe('$189.00')
  expect(formatMoney(123456, 'USD')).toBe('$1,234.56')
  expect(formatMoney(0, 'USD')).toBe('$0.00')
  expect(formatMoney(150000, 'PHP')).toBe('₱1,500.00')
})
