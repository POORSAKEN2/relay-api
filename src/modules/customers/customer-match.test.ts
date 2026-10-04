import { expect, it } from 'vitest'
import { customerMatchKey } from './customer-match.ts'

it('ignores case and extra spaces in the name', () => {
  expect(customerMatchKey('+16025550111', '  maria   LOPEZ ')).toBe('+16025550111|maria lopez')
  expect(customerMatchKey('+16025550111', 'Maria Lopez')).toBe(
    customerMatchKey('+16025550111', 'maria lopez'),
  )
})

it('tells apart a different phone or a different name', () => {
  const maria = customerMatchKey('+16025550111', 'Maria Lopez')
  expect(customerMatchKey('+16025550112', 'Maria Lopez')).not.toBe(maria)
  expect(customerMatchKey('+16025550111', 'Mario Lopez')).not.toBe(maria)
})
