import { expect, it } from 'vitest'
import { isAllowedOrigin } from './origins.ts'

it('allows https subdomains of the app domain', () => {
  expect(isAllowedOrigin('https://desert.garified.com', 'garified.com', true)).toBe(true)
})

it('allows plain http outside production only', () => {
  expect(isAllowedOrigin('http://desert.garified.com', 'garified.com', true)).toBe(false)
  expect(isAllowedOrigin('http://desert.localhost:5173', 'localhost', false)).toBe(true)
})

it('refuses other sites, including look-alikes', () => {
  expect(isAllowedOrigin('https://evil.com', 'garified.com', true)).toBe(false)
  expect(isAllowedOrigin('https://desertgarified.com', 'garified.com', true)).toBe(false)
  expect(isAllowedOrigin('https://garified.com.evil.com', 'garified.com', true)).toBe(false)
  expect(isAllowedOrigin('not a url', 'garified.com', true)).toBe(false)
})
