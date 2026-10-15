import { describe, expect, it } from 'vitest'
import { env } from '../../config/env.ts'
import { siteUrl } from '../../lib/tenant-url.ts'
import { parseSiteHost } from './site-host.ts'

describe('parseSiteHost', () => {
  it.each([
    ['desert.site.garified.com', 'desert'],
    ['DESERT.Site.Garified.com', 'desert'],
    ['desert.site.garified.com:443', 'desert'],
    ['desert.site.garified.com.', 'desert'],
    ['desert-breeze.site.garified.com', 'desert-breeze'],
  ])('%s is the site of %s', (host, slug) => {
    expect(parseSiteHost(host, 'garified.com')).toEqual({ slug })
  })

  it.each([
    'garified.com',
    'site.garified.com',
    'desert.garified.com',
    'api.garified.com',
    'a.b.site.garified.com',
    'desert.site.other.com',
    '',
  ])('%s is not a site', (host) => {
    expect(parseSiteHost(host, 'garified.com')).toBeNull()
  })

  it('works on a developer machine', () => {
    expect(parseSiteHost('desert.site.localhost:3000', 'localhost')).toEqual({ slug: 'desert' })
  })
})

it('siteUrl points at the local server outside production', () => {
  expect(siteUrl('desert')).toBe(`http://desert.site.localhost:${env.PORT}/`)
})
