import { expect, it } from 'vitest'
import { parseEnv } from './env.ts'

const required = {
  DATABASE_URL: 'postgres://relay:relay@localhost:5432/relay',
  APP_DOMAIN: 'localhost',
  SIGN_IN_CODE_SECRET: 'a-secret-that-is-at-least-32-chars-long',
}

it('fills in defaults', () => {
  expect(parseEnv(required)).toEqual({
    ...required,
    NODE_ENV: 'development',
    PORT: 3000,
    LOG_LEVEL: 'info',
  })
})

it('treats an empty value as not set', () => {
  expect(parseEnv({ ...required, SENTRY_DSN: '' }).SENTRY_DSN).toBeUndefined()
})

it('names every invalid variable', () => {
  expect(() => parseEnv({ PORT: 'abc' })).toThrow(/DATABASE_URL/)
  expect(() => parseEnv({ PORT: 'abc' })).toThrow(/APP_DOMAIN/)
  expect(() => parseEnv({ PORT: 'abc' })).toThrow(/PORT/)
})

it('refuses a sign-in code secret shorter than 32 characters', () => {
  expect(() => parseEnv({ ...required, SIGN_IN_CODE_SECRET: 'short' })).toThrow(
    /SIGN_IN_CODE_SECRET/,
  )
})
