import { expect, it } from 'vitest'
import { noAccessText, onMyWayText, runningLateText } from './texts.ts'

const who = { contractorName: 'Desert Breeze Air', technicianName: 'Sam Patel' }

it('says the technician is on the way, with their first name only', () => {
  expect(onMyWayText(who, '9:10 AM')).toBe(
    'Desert Breeze Air: Sam is on the way and should arrive about 9:10 AM.',
  )
})

it('gives the new arrival time when running late', () => {
  expect(runningLateText(who, '11:15 AM')).toBe(
    'Desert Breeze Air: Sam is running late and should now arrive about 11:15 AM. Sorry for the wait.',
  )
})

it('says when the technician came by and that the office will call', () => {
  expect(noAccessText(who, '1:30 PM')).toBe(
    "Desert Breeze Air: Sam came by at 1:30 PM but couldn't reach you. We'll call you to set a new time.",
  )
})
