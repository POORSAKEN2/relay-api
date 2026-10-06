import { expect, it } from 'vitest'
import { addDays, localToday, mondayOf } from './local-day.ts'

it('advances a normal day to tomorrow', () => {
  expect(addDays('2026-10-06', 1)).toBe('2026-10-07')
})

it('advances the end of a month into the next month', () => {
  expect(addDays('2026-10-31', 1)).toBe('2026-11-01')
})

it('advances the end of a year into the new year', () => {
  expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
})

it('advances 28 Feb to 29 Feb in a leap year', () => {
  expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
})

it('advances 28 Feb to 1 Mar in a non-leap year', () => {
  expect(addDays('2026-02-28', 1)).toBe('2026-03-01')
})

it('goes back with a negative count, across a year', () => {
  expect(addDays('2027-01-03', -7)).toBe('2026-12-27')
})

it('finds the Monday of a week', () => {
  expect(mondayOf('2026-10-05')).toBe('2026-10-05') // a Monday
  expect(mondayOf('2026-10-07')).toBe('2026-10-05') // a Wednesday
  expect(mondayOf('2026-10-11')).toBe('2026-10-05') // a Sunday: the end of that week
  expect(mondayOf('2026-11-01')).toBe('2026-10-26') // a Sunday, across a month
  expect(mondayOf('2027-01-02')).toBe('2026-12-28') // a Saturday, across a year
})

it('gives the local date in a time zone', () => {
  // 03:00 UTC on Oct 7 is still Oct 6 in Phoenix (UTC-7).
  const now = new Date('2026-10-07T03:00:00Z')
  expect(localToday('America/Phoenix', now)).toBe('2026-10-06')
  expect(localToday('Asia/Manila', now)).toBe('2026-10-07')
})
