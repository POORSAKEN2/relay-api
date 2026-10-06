import { expect, it } from 'vitest'
import { transferTarget } from './transfer.ts'

const OFFICE = '+16025550100'
const ON_CALL = '+16025550199'
const both = { officePhone: OFFICE, onCallPhone: ON_CALL }
const windows = [
  { startsAt: '12:00:00', endsAt: '16:00:00' },
  { startsAt: '08:00:00', endsAt: '12:00:00' },
]

it('sends calls during business hours to the office', () => {
  expect(transferTarget(both, windows, '08:00:00')).toBe(OFFICE)
  expect(transferTarget(both, windows, '15:59:59')).toBe(OFFICE)
})

it('sends calls after hours, or on a day with no windows, to the on-call phone', () => {
  expect(transferTarget(both, windows, '07:59:00')).toBe(ON_CALL)
  expect(transferTarget(both, windows, '16:00:00')).toBe(ON_CALL)
  expect(transferTarget(both, [], '10:00:00')).toBe(ON_CALL)
})

it('uses the one number set, whatever the hour', () => {
  expect(transferTarget({ officePhone: OFFICE, onCallPhone: null }, windows, '22:00:00')).toBe(
    OFFICE,
  )
  expect(transferTarget({ officePhone: null, onCallPhone: ON_CALL }, windows, '10:00:00')).toBe(
    ON_CALL,
  )
})

it('has nobody to transfer to when no number is set', () => {
  expect(transferTarget({ officePhone: null, onCallPhone: null }, windows, '10:00:00')).toBeNull()
})
