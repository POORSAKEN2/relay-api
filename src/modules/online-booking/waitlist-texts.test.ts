import { expect, it } from 'vitest'
import { offerText, takenOffText } from './waitlist-texts.ts'

it('offers the place with its link and how long it is held', () => {
  expect(
    offerText({
      tenantName: 'Desert Breeze Air',
      dayLabel: 'Tue, Oct 7',
      windowLabel: '8 AM - 12 PM',
      link: 'https://desert.garified.com/?offer=Xk3',
    }),
  ).toBe(
    "Desert Breeze Air: a time opened up: Tue, Oct 7, 8 AM - 12 PM. It's yours for 30 minutes: https://desert.garified.com/?offer=Xk3 Reply STOP to opt out.",
  )
})

it('says the homeowner is off the waitlist, with the booking page', () => {
  expect(
    takenOffText({ tenantName: 'Desert Breeze Air', link: 'https://desert.garified.com/' }),
  ).toBe(
    "Desert Breeze Air: we've taken you off the waitlist. Book anytime: https://desert.garified.com/ Reply STOP to opt out.",
  )
})
