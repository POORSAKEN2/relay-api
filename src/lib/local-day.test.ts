import { expect, it } from 'vitest'
import { nextDay } from './local-day.ts'

it('advances a normal day to tomorrow', () => {
  expect(nextDay('2026-10-06')).toBe('2026-10-07')
})

it('advances the end of a month into the next month', () => {
  expect(nextDay('2026-10-31')).toBe('2026-11-01')
})

it('advances the end of a year into the new year', () => {
  expect(nextDay('2026-12-31')).toBe('2027-01-01')
})

it('advances 28 Feb to 29 Feb in a leap year', () => {
  expect(nextDay('2028-02-28')).toBe('2028-02-29')
})

it('advances 28 Feb to 1 Mar in a non-leap year', () => {
  expect(nextDay('2026-02-28')).toBe('2026-03-01')
})
