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
    SMS_PROVIDER: 'log',
    EMAIL_PROVIDER: 'log',
    SMTP_HOST: 'smtp.gmail.com',
    SMTP_PORT: 465,
    LLM_PROVIDER: 'off',
    GROQ_MODEL: 'openai/gpt-oss-20b',
    ANTHROPIC_MODEL: 'claude-haiku-4-5',
    LLM_TIMEOUT_MS: 8000,
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

it('needs both httpSMS keys to send real texts', () => {
  expect(() => parseEnv({ ...required, SMS_PROVIDER: 'httpsms' })).toThrow(/HTTPSMS_API_KEY/)
  expect(() => parseEnv({ ...required, SMS_PROVIDER: 'httpsms' })).toThrow(
    /HTTPSMS_WEBHOOK_SIGNING_KEY/,
  )
  const keys = { HTTPSMS_API_KEY: 'key', HTTPSMS_WEBHOOK_SIGNING_KEY: 'signing' }
  expect(parseEnv({ ...required, SMS_PROVIDER: 'httpsms', ...keys }).SMS_PROVIDER).toBe('httpsms')
})

it('needs the Gmail login and sender to send real emails', () => {
  expect(() => parseEnv({ ...required, EMAIL_PROVIDER: 'smtp' })).toThrow(/SMTP_USER/)
  expect(() => parseEnv({ ...required, EMAIL_PROVIDER: 'smtp' })).toThrow(/SMTP_PASSWORD/)
  expect(() => parseEnv({ ...required, EMAIL_PROVIDER: 'smtp' })).toThrow(/EMAIL_FROM/)
  const login = {
    SMTP_USER: 'a@gmail.com',
    SMTP_PASSWORD: 'app-password',
    EMAIL_FROM: 'a@gmail.com',
  }
  expect(parseEnv({ ...required, EMAIL_PROVIDER: 'smtp', ...login }).EMAIL_PROVIDER).toBe('smtp')
})

it('needs the chosen language model provider’s key', () => {
  expect(() => parseEnv({ ...required, LLM_PROVIDER: 'groq' })).toThrow(/GROQ_API_KEY/)
  expect(() => parseEnv({ ...required, LLM_PROVIDER: 'anthropic' })).toThrow(/ANTHROPIC_API_KEY/)
  expect(parseEnv({ ...required, LLM_PROVIDER: 'groq', GROQ_API_KEY: 'k' }).LLM_PROVIDER).toBe(
    'groq',
  )
  expect(() => parseEnv({ ...required, LLM_PROVIDER: 'openai' })).toThrow(/LLM_PROVIDER/)
})
