import { expect, it } from 'vitest'
import { parseTenantHost } from './tenant.ts'

it.each([
  ['desert.garified.com', { slug: 'desert' }],
  ['DESERT.garified.com', { slug: 'desert' }],
  ['desert.garified.com:443', { slug: 'desert' }],
  ['book.desertbreezeair.com', { customDomain: 'book.desertbreezeair.com' }],
  ['garified.com', null],
  ['a.b.garified.com', null],
  ['', null],
])('%s', (host, expected) => {
  expect(parseTenantHost(host, 'garified.com')).toEqual(expected)
})
