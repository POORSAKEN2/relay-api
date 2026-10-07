import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { hashLinkToken, newLinkToken } from './link-token.ts'

it('makes a short, URL-safe token that is different every time', () => {
  const first = newLinkToken()
  expect(first.token).toMatch(/^[A-Za-z0-9_-]{24}$/)
  expect(newLinkToken().token).not.toBe(first.token)
})

it('stores only the token’s sha256', () => {
  const { token, hash } = newLinkToken()
  expect(hash).toBe(createHash('sha256').update(token).digest('hex'))
  expect(hashLinkToken(token)).toBe(hash)
})
