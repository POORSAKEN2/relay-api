import { expect, it } from 'vitest'
import { abandonedBookingText, missedCallerReminderText } from './recovery-texts.ts'

const WINDOWS = ['Tue, Oct 13 8 AM - 12 PM', 'Tue, Oct 13 12 PM - 4 PM', 'Wed, Oct 14 8 AM - 12 PM']
const LINK = 'https://acme.example/?resume=abc'

it('lists the open times in the abandoned-booking text', () => {
  expect(abandonedBookingText({ tenantName: 'Acme HVAC', windows: WINDOWS, link: LINK })).toBe(
    'Acme HVAC: you started booking a visit. Open times: Tue, Oct 13 8 AM - 12 PM; Tue, Oct 13 12 PM - 4 PM; Wed, Oct 14 8 AM - 12 PM. Finish here: https://acme.example/?resume=abc Reply STOP to opt out.',
  )
})

it('lists only the open times there are', () => {
  expect(
    abandonedBookingText({ tenantName: 'Acme HVAC', windows: WINDOWS.slice(0, 1), link: LINK }),
  ).toBe(
    'Acme HVAC: you started booking a visit. Open times: Tue, Oct 13 8 AM - 12 PM. Finish here: https://acme.example/?resume=abc Reply STOP to opt out.',
  )
})

it('leaves the open times out when none are open', () => {
  expect(abandonedBookingText({ tenantName: 'Acme HVAC', windows: [], link: LINK })).toBe(
    'Acme HVAC: you started booking a visit. Finish here: https://acme.example/?resume=abc Reply STOP to opt out.',
  )
})

it('words the missed-caller reminder the same way', () => {
  expect(missedCallerReminderText({ tenantName: 'Acme HVAC', windows: WINDOWS, link: LINK })).toBe(
    'Acme HVAC: still need a visit? Sorry we missed your call. Open times: Tue, Oct 13 8 AM - 12 PM; Tue, Oct 13 12 PM - 4 PM; Wed, Oct 14 8 AM - 12 PM. Book here: https://acme.example/?resume=abc Reply STOP to opt out.',
  )
  expect(missedCallerReminderText({ tenantName: 'Acme HVAC', windows: [], link: LINK })).toBe(
    'Acme HVAC: still need a visit? Sorry we missed your call. Book here: https://acme.example/?resume=abc Reply STOP to opt out.',
  )
})

it('stays plain ASCII', () => {
  const texts = [
    abandonedBookingText({ tenantName: 'Acme HVAC', windows: WINDOWS, link: LINK }),
    missedCallerReminderText({ tenantName: 'Acme HVAC', windows: WINDOWS, link: LINK }),
  ]
  for (const text of texts) expect(text).toMatch(/^[\x20-\x7e]*$/)
})
