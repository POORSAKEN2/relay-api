import { expect, it } from 'vitest'
import { Phone } from './fields.ts'

it('reads Philippine mobiles in every common form', () => {
  expect(Phone.parse('0917 123 4567')).toBe('+639171234567')
  expect(Phone.parse('0917-123-4567')).toBe('+639171234567')
  expect(Phone.parse('639171234567')).toBe('+639171234567')
  expect(Phone.parse('+63 917 123 4567')).toBe('+639171234567')
})

it('still reads US numbers', () => {
  expect(Phone.parse('(480) 555-0199')).toBe('+14805550199')
  expect(Phone.parse('1 480 555 0199')).toBe('+14805550199')
  expect(Phone.parse('+1 480 555 0199')).toBe('+14805550199')
})

it('refuses anything else', () => {
  for (const value of ['', '555', '0917 123 456', '1234567890', '+0 917 123 4567']) {
    expect(Phone.safeParse(value).error?.issues[0].message).toBe(
      'Enter a mobile number, like 0917 123 4567',
    )
  }
})
