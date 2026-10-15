import { describe, expect, it } from 'vitest'
import { siteData } from '../../../test/site-fixture.ts'
import { SITE_DESIGNS, type SiteDesign } from '../../db/schema.ts'
import { renderSite } from './designs/index.ts'
import { buildSiteView } from './site-view.ts'

const SECTIONS = [
  'top',
  'services',
  'how',
  'reviews',
  'photos',
  'about',
  'area',
  'hours',
  'faq',
  'book',
]
const CLAIMS = [
  'Licensed · AZ ROC #123456',
  '24/7 emergency service',
  'A text when we’re on the way',
  'Price approved before work starts',
]
const page = (overrides: Parameters<typeof siteData>[0] = {}, design: SiteDesign = 'breeze') =>
  renderSite(buildSiteView(siteData({ ...overrides, site: { design, ...overrides.site } })))

describe.each(SITE_DESIGNS)('%s', (design) => {
  it('is a whole document with the title', () => {
    const html = page({}, design)
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('<title>Desert Breeze Air | AC &amp; Heating Repair in Phoenix</title>')
    expect(html).toContain('<script type="application/ld+json">')
  })

  it('links the phone and the booking page', () => {
    const html = page({}, design)
    expect(html).toContain('href="tel:+16025550142"')
    expect(html).toContain('href="https://desert.localhost/"')
  })

  it('shows every section in order, with its content', () => {
    const html = page({}, design)
    const positions = SECTIONS.map((id) => html.indexOf(`id="${id}"`))
    expect(positions.every((at) => at > 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    for (const text of [
      'Too hot inside? We’ll bring it back to 76°.',
      'AC repair',
      '$89 diagnostic',
      'Free estimate',
      'Maria G.',
      'Fixed the same day.',
      'How do I pay?',
      'Family-run since 2009.',
      'Mesa',
      'Mon–Sat 7 AM–7 PM',
      ...CLAIMS,
    ]) {
      expect(html).toContain(text)
    }
    expect(html).toContain('alt="Technician at a rooftop unit"')
  })

  it('leaves out empty sections and unbacked claims', () => {
    const html = page(
      {
        services: [],
        reviews: [],
        faqs: [],
        photos: [],
        hours: [],
        tenant: { textingStatus: 'pending' },
        site: {
          about: null,
          citiesServed: [],
          licenseNumber: null,
          emergencyService: false,
          showPrices: false,
        },
      },
      design,
    )
    for (const id of ['services', 'reviews', 'photos', 'about', 'area', 'hours', 'faq']) {
      expect(html).not.toContain(`id="${id}"`)
    }
    for (const id of ['top', 'how', 'book']) expect(html).toContain(`id="${id}"`)
    for (const claim of CLAIMS) expect(html).not.toContain(claim)
    expect(html).not.toContain('undefined')
  })

  it('shows contractor text as text', () => {
    const review = {
      id: 'r1',
      tenantId: 't1',
      authorName: 'Tom "T" O’Neil',
      place: null,
      rating: 4,
      body: '<img src=x onerror=alert(1)>',
      sortOrder: 0,
      createdAt: new Date(),
    }
    const html = page({ reviews: [review] }, design)
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('4 out of 5 stars')
  })
})

it('breeze links its own stylesheet and the shared script', () => {
  const html = page()
  expect(html).toMatch(/href="\/api\/site\/assets\/breeze\.css\?v=[0-9a-f]{10}"/)
  expect(html).toMatch(/src="\/api\/site\/assets\/site\.js\?v=[0-9a-f]{10}"/)
})
