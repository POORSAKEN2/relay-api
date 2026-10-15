import { describe, expect, it } from 'vitest'
import { siteData } from '../../../test/site-fixture.ts'
import { siteUrl } from '../../lib/tenant-url.ts'
import { buildSiteView, hoursLines, openingHours, priceLabel, textColorOn } from './site-view.ts'

const HERO = '00000000-0000-4000-8000-000000000002'
const day = (weekday: number, opensAt: string, closesAt: string) => ({
  weekday,
  opensAt,
  closesAt,
})

describe('buildSiteView', () => {
  it('shows every claim the data backs, in order', () => {
    expect(buildSiteView(siteData()).claims).toEqual([
      'Licensed · AZ ROC #123456',
      '24/7 emergency service',
      'A text when we’re on the way',
      'Price approved before work starts',
    ])
  })

  it('drops each claim its data does not back', () => {
    const data = siteData({
      site: { licenseNumber: null, emergencyService: false, showPrices: false },
      tenant: { textingStatus: 'pending' },
    })
    expect(buildSiteView(data).claims).toEqual([])
  })

  it('links the phone, booking page, photos and logo', () => {
    const view = buildSiteView(
      siteData({
        branding: {
          primaryColor: '#1d4ed8',
          accentColor: '#0ea5e9',
          logoAssetId: 'logo-id',
          faviconAssetId: null,
        },
      }),
    )
    expect(view.phone).toEqual({ display: '(602) 555-0142', href: 'tel:+16025550142' })
    expect(view.bookingUrl).toBe('https://desert.localhost/')
    expect(view.heroPhoto).toEqual({
      url: `/api/site/photos/${HERO}`,
      alt: 'Technician at a rooftop unit',
    })
    expect(view.workPhotos).toHaveLength(1)
    expect(view.logoUrl).toBe('/api/branding/assets/logo-id')
    expect(view.place).toBe('Phoenix, AZ')
  })

  it('hides prices when show_prices is off', () => {
    const view = buildSiteView(siteData({ site: { showPrices: false } }))
    expect(view.services.map((service) => service.price)).toEqual([null, null])
  })
})

describe('priceLabel', () => {
  it.each([
    ['fixed', 8900, '$89'],
    ['fixed', 8950, '$89.50'],
    ['diagnostic', 8900, '$89 diagnostic'],
    ['free', 0, 'Free estimate'],
  ] as const)('%s %i is %s', (priceType, priceCents, label) => {
    expect(priceLabel({ priceType, priceCents }, 'USD')).toBe(label)
  })
})

describe('hours', () => {
  it('joins days in a row with the same hours, Monday first', () => {
    const hours = [1, 2, 3, 4, 5]
      .map((d) => day(d, '07:00:00', '19:00:00'))
      .concat(day(6, '08:00:00', '14:00:00'))
    expect(hoursLines(hours)).toEqual(['Mon–Fri 7 AM–7 PM', 'Sat 8 AM–2 PM'])
    expect(openingHours(hours)).toEqual(['Mo-Fr 07:00-19:00', 'Sa 08:00-14:00'])
  })

  it('splits around a closed day', () => {
    const hours = [day(1, '08:00:00', '17:00:00'), day(3, '08:00:00', '17:00:00')]
    expect(hoursLines(hours)).toEqual(['Mon 8 AM–5 PM', 'Wed 8 AM–5 PM'])
  })

  it('puts Sunday last when every day is open', () => {
    const hours = [0, 1, 2, 3, 4, 5, 6].map((d) => day(d, '07:00:00', '19:00:00'))
    expect(hoursLines(hours)).toEqual(['Mon–Sun 7 AM–7 PM'])
    expect(openingHours(hours)).toEqual(['Mo-Su 07:00-19:00'])
  })

  it('is empty when no day is open', () => {
    expect(hoursLines([])).toEqual([])
  })
})

it.each([
  ['#ffffff', '#000000'],
  ['#1d4ed8', '#ffffff'],
  ['#f4b02a', '#000000'],
  ['#777777', '#000000'],
  ['#16182b', '#ffffff'],
])('text on %s is %s', (background, text) => {
  expect(textColorOn(background)).toBe(text)
})

describe('jsonLd', () => {
  it('describes the business', () => {
    expect(JSON.parse(buildSiteView(siteData()).jsonLd)).toEqual({
      '@context': 'https://schema.org',
      '@type': 'HVACBusiness',
      name: 'Desert Breeze Air',
      telephone: '+16025550142',
      url: siteUrl('desert'),
      address: {
        '@type': 'PostalAddress',
        addressLocality: 'Phoenix',
        addressRegion: 'AZ',
        addressCountry: 'US',
      },
      areaServed: ['Phoenix', 'Mesa'],
      openingHours: ['Mo-Sa 07:00-19:00'],
    })
  })

  it('leaves out an empty service area and hours', () => {
    const json = JSON.parse(
      buildSiteView(siteData({ hours: [], site: { citiesServed: [] } })).jsonLd,
    )
    expect(json).not.toHaveProperty('areaServed')
    expect(json).not.toHaveProperty('openingHours')
  })

  it('cannot close its own script tag', () => {
    const jsonLd = buildSiteView(siteData({ tenant: { name: '</script><script>x' } })).jsonLd
    expect(jsonLd).not.toContain('<')
    expect(JSON.parse(jsonLd).name).toBe('</script><script>x')
  })
})
