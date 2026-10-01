import { expect, it } from 'vitest'
import { formatClock } from './labels.ts'

it('shows a moment as the contractor’s wall clock', () => {
  expect(formatClock(new Date('2030-01-08T16:10:00Z'), 'America/Phoenix')).toBe('9:10 AM')
  expect(formatClock(new Date('2030-01-08T19:00:00Z'), 'America/Phoenix')).toBe('12 PM')
  // Daylight saving time: Los Angeles is UTC-7 in July.
  expect(formatClock(new Date('2030-07-08T16:10:00Z'), 'America/Los_Angeles')).toBe('9:10 AM')
})
