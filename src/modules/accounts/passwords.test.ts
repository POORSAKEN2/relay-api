import { expect, it } from 'vitest'
import { hashPassword, verifyPassword } from './passwords.ts'

it('accepts the right password and rejects a wrong one', async () => {
  const hash = await hashPassword('correct horse')
  expect(hash).toMatch(/^scrypt\$16384\$8\$5\$/)
  expect(await verifyPassword('correct horse', hash)).toBe(true)
  expect(await verifyPassword('wrong horse', hash)).toBe(false)
})

it('salts every hash', async () => {
  expect(await hashPassword('same')).not.toBe(await hashPassword('same'))
})

it('rejects a malformed stored hash', async () => {
  expect(await verifyPassword('anything', 'not-a-hash')).toBe(false)
})
