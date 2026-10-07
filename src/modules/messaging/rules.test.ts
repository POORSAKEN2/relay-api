import { expect, it } from 'vitest'
import { HOMEOWNER_KINDS, quietUntil, TEXT_RULES } from './rules.ts'

// Manila is UTC+8 with no daylight saving. Quiet hours 21:00 to 08:00.
const manila = (time: string) => new Date(`2030-01-08T${time}+08:00`)
const quiet = (time: string) => quietUntil(manila(time), 'Asia/Manila', '21:00:00', '08:00:00')

it('lets a text go outside quiet hours', () => {
  expect(quiet('08:00:00')).toBeNull()
  expect(quiet('14:30:00')).toBeNull()
  expect(quiet('20:59:59')).toBeNull()
})

it('holds a text until 8 AM, before or after midnight', () => {
  expect(quiet('21:00:00')).toEqual(new Date('2030-01-09T08:00:00+08:00'))
  expect(quiet('23:15:30')).toEqual(new Date('2030-01-09T08:00:00+08:00'))
  expect(quiet('03:00:00')).toEqual(new Date('2030-01-08T08:00:00+08:00'))
})

it('handles a window that doesn’t cross midnight', () => {
  const lunch = (time: string) => quietUntil(manila(time), 'Asia/Manila', '12:00:00', '13:00:00')
  expect(lunch('12:20:00')).toEqual(manila('13:00:00'))
  expect(lunch('13:00:00')).toBeNull()
  expect(lunch('23:00:00')).toBeNull()
})

it('never checks consent or quiet hours for staff texts', () => {
  for (const kind of ['sign_in_code', 'job_assigned', 'priority_alert'] as const) {
    expect(TEXT_RULES[kind]).toEqual({ consent: 'none', quietHours: false })
  }
})

it('holds routine office alerts for quiet hours with no consent check', () => {
  expect(TEXT_RULES.new_booking_alert).toEqual({ consent: 'none', quietHours: true })
})

it('holds only texts the homeowner didn’t just ask for', () => {
  expect(TEXT_RULES.abandoned_booking.quietHours).toBe(true)
  expect(TEXT_RULES.reminder.quietHours).toBe(true)
  expect(TEXT_RULES.on_my_way.quietHours).toBe(false)
  expect(TEXT_RULES.text_back).toEqual({ consent: 'opt_out', quietHours: false })
})

it('identifies homeowner kinds by whether their rule checks consent', () => {
  for (const kind of ['on_my_way', 'text_back', 'reminder', 'manual'] as const) {
    expect(HOMEOWNER_KINDS).toContain(kind)
  }
  for (const kind of [
    'sign_in_code',
    'job_assigned',
    'new_booking_alert',
    'priority_alert',
    'inbound',
  ] as const) {
    expect(HOMEOWNER_KINDS).not.toContain(kind)
  }
})
