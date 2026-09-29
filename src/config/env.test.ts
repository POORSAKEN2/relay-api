import { expect, it } from 'vitest'
import { parseEnv } from './env.ts'

const required = {
  DATABASE_URL: 'postgres://relay:relay@localhost:5432/relay',
  APP_DOMAIN: 'localhost',
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
