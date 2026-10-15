import type { Site } from '../src/db/schema.ts'
import type { PublicSiteData } from '../src/modules/sites/site-view.ts'

export type SiteDataOverrides = Omit<Partial<PublicSiteData>, 'site' | 'tenant'> & {
  site?: Partial<Site>
  tenant?: Partial<PublicSiteData['tenant']>
}

const TENANT_ID = '00000000-0000-4000-8000-000000000001'
const CREATED_AT = new Date('2030-01-01T00:00:00Z')

// Desert Breeze Air's site, as loaded from the database, for tests that need no database.
// `site` and `tenant` are merged with the overrides; every other key is replaced.
export function siteData(overrides: SiteDataOverrides = {}): PublicSiteData {
  const { site, tenant, ...rest } = overrides
  return {
    tenant: {
      name: 'Desert Breeze Air',
      slug: 'desert',
      currency: 'USD',
      customDomain: null,
      customDomainVerifiedAt: null,
      textingStatus: 'approved',
      ...tenant,
    },
    site: {
      tenantId: TENANT_ID,
      design: 'breeze',
      publishedAt: CREATED_AT,
      headline: 'Too hot inside? We’ll bring it back to 76°.',
      intro: 'AC and heating repair across the Phoenix metro.',
      about: 'Family-run since 2009.',
      licenseNumber: 'AZ ROC #123456',
      city: 'Phoenix',
      region: 'AZ',
      citiesServed: ['Phoenix', 'Mesa'],
      emergencyService: true,
      showPrices: true,
      updatedAt: CREATED_AT,
      createdAt: CREATED_AT,
      ...site,
    },
    phone: '+16025550142',
    branding: {
      primaryColor: '#1d4ed8',
      accentColor: '#0ea5e9',
      logoAssetId: null,
      faviconAssetId: null,
    },
    services: [
      {
        name: 'AC repair',
        description: 'Diagnosis and repair.',
        priceType: 'diagnostic',
        priceCents: 8900,
      },
      { name: 'New-system estimate', description: null, priceType: 'free', priceCents: 0 },
    ],
    hours: [1, 2, 3, 4, 5, 6].map((weekday) => ({
      weekday,
      opensAt: '07:00:00',
      closesAt: '19:00:00',
    })),
    reviews: [
      {
        id: '00000000-0000-4000-8000-000000000004',
        tenantId: TENANT_ID,
        authorName: 'Maria G.',
        place: 'Mesa',
        rating: 5,
        body: 'Fixed the same day.',
        sortOrder: 0,
        createdAt: CREATED_AT,
      },
    ],
    faqs: [
      {
        id: '00000000-0000-4000-8000-000000000005',
        tenantId: TENANT_ID,
        question: 'How do I pay?',
        answer: 'Card or cash after the visit.',
        sortOrder: 0,
        createdAt: CREATED_AT,
      },
    ],
    photos: [
      {
        id: '00000000-0000-4000-8000-000000000002',
        kind: 'hero',
        altText: 'Technician at a rooftop unit',
      },
      { id: '00000000-0000-4000-8000-000000000003', kind: 'work', altText: 'New condenser' },
    ],
    ...rest,
  }
}
