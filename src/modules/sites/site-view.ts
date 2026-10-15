import type {
  PRICE_TYPES,
  Site,
  SiteDesign,
  SiteFaq,
  SitePhotoKind,
  SiteReview,
  Tenant,
} from '../../db/schema.ts'
import { formatMoney, formatPhone, formatWindow } from '../../lib/labels.ts'
import { siteUrl, tenantUrl } from '../../lib/tenant-url.ts'

// Turns a contractor's rows into exactly what a design shows. No database here, so every rule
// about wording, prices, hours and claims is tested directly (site-view.test.ts).

type PriceType = (typeof PRICE_TYPES)[number]
type OpenDay = { weekday: number; opensAt: string; closesAt: string } // '07:00:00'

export type PublicSiteData = {
  tenant: Pick<
    Tenant,
    'name' | 'slug' | 'currency' | 'customDomain' | 'customDomainVerifiedAt' | 'textingStatus'
  >
  site: Site
  phone: string // E.164: the active Relay number, else tenants.contact_phone
  branding: {
    primaryColor: string
    accentColor: string
    logoAssetId: string | null
    faviconAssetId: string | null
  }
  services: { name: string; description: string | null; priceType: PriceType; priceCents: number }[]
  hours: OpenDay[]
  reviews: SiteReview[]
  faqs: SiteFaq[]
  photos: { id: string; kind: SitePhotoKind; altText: string }[]
}

export type SiteView = {
  design: SiteDesign
  name: string
  headline: string
  intro: string
  about: string | null
  city: string
  place: string // 'Phoenix, AZ'
  citiesServed: string[]
  licenseNumber: string | null
  emergency: boolean // shows the 24/7 emergency band
  claims: string[] // trust lines, only those the data backs
  phone: { display: string; href: string } // '(602) 555-0142', 'tel:+16025550142'
  bookingUrl: string
  brand: { primary: string; onPrimary: string; accent: string; onAccent: string }
  logoUrl: string | null // '/api/branding/assets/<id>'
  faviconUrl: string | null
  heroPhoto: { url: string; alt: string } | null // url '/api/site/photos/<id>'
  workPhotos: { url: string; alt: string }[]
  services: { name: string; description: string | null; price: string | null }[]
  hours: string[] // ['Mon–Fri 7 AM–7 PM', 'Sat 8 AM–2 PM']
  reviews: { authorName: string; place: string | null; rating: number; body: string }[]
  faqs: { question: string; answer: string }[]
  jsonLd: string // JSON with every '<' written as <
}

export function buildSiteView(data: PublicSiteData): SiteView {
  const { tenant, site, branding } = data
  const hero = data.photos.find((photo) => photo.kind === 'hero')
  return {
    design: site.design,
    name: tenant.name,
    headline: site.headline,
    intro: site.intro,
    about: site.about,
    city: site.city,
    place: `${site.city}, ${site.region}`,
    citiesServed: site.citiesServed,
    licenseNumber: site.licenseNumber,
    emergency: site.emergencyService,
    claims: claims(data),
    phone: { display: formatPhone(data.phone), href: `tel:${data.phone}` },
    bookingUrl: tenantUrl(tenant, '/'),
    brand: {
      primary: branding.primaryColor,
      onPrimary: textColorOn(branding.primaryColor),
      accent: branding.accentColor,
      onAccent: textColorOn(branding.accentColor),
    },
    logoUrl: brandingAssetUrl(branding.logoAssetId),
    faviconUrl: brandingAssetUrl(branding.faviconAssetId),
    heroPhoto: hero ? { url: photoUrl(hero.id), alt: hero.altText } : null,
    workPhotos: data.photos
      .filter((photo) => photo.kind === 'work')
      .map((photo) => ({ url: photoUrl(photo.id), alt: photo.altText })),
    services: data.services.map((service) => ({
      name: service.name,
      description: service.description,
      price: site.showPrices ? priceLabel(service, tenant.currency) : null,
    })),
    hours: hoursLines(data.hours),
    reviews: data.reviews.map(({ authorName, place, rating, body }) => ({
      authorName,
      place,
      rating,
      body,
    })),
    faqs: data.faqs.map(({ question, answer }) => ({ question, answer })),
    jsonLd: jsonLd(data),
  }
}

// The page states a fact only when the data backs it (spec, "Claims").
function claims({ tenant, site }: PublicSiteData): string[] {
  const lines: string[] = []
  if (site.licenseNumber) lines.push(`Licensed · ${site.licenseNumber}`)
  if (site.emergencyService) lines.push('24/7 emergency service')
  if (tenant.textingStatus === 'approved') lines.push('A text when we’re on the way')
  if (site.showPrices) lines.push('Price approved before work starts')
  return lines
}

function brandingAssetUrl(assetId: string | null): string | null {
  return assetId ? `/api/branding/assets/${assetId}` : null
}

function photoUrl(photoId: string): string {
  return `/api/site/photos/${photoId}`
}

// 8900 fixed → '$89', 8950 fixed → '$89.50', 8900 diagnostic → '$89 diagnostic'.
export function priceLabel(
  service: { priceType: PriceType; priceCents: number },
  currency: string,
): string {
  if (service.priceType === 'free') return 'Free estimate'
  const money = formatMoney(service.priceCents, currency).replace(/\.00$/, '')
  return service.priceType === 'diagnostic' ? `${money} diagnostic` : money
}

// Monday first, Sunday last, as a week reads on a shop's door.
const WEEK = [1, 2, 3, 4, 5, 6, 0]
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DAY_CODES = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'] // schema.org openingHours

type HoursGroup = { first: number; last: number; opensAt: string; closesAt: string }

// Neighbouring open days with the same hours become one group. A closed day breaks a group.
function groupHours(hours: OpenDay[]): HoursGroup[] {
  const groups: HoursGroup[] = []
  let previous: HoursGroup | undefined
  for (const weekday of WEEK) {
    const day = hours.find((h) => h.weekday === weekday)
    if (!day) {
      previous = undefined
      continue
    }
    if (previous && previous.opensAt === day.opensAt && previous.closesAt === day.closesAt) {
      previous.last = weekday
    } else {
      previous = { first: weekday, last: weekday, opensAt: day.opensAt, closesAt: day.closesAt }
      groups.push(previous)
    }
  }
  return groups
}

// ['Mon–Fri 7 AM–7 PM', 'Sat 8 AM–2 PM']
export function hoursLines(hours: OpenDay[]): string[] {
  return groupHours(hours).map((group) => {
    const days =
      group.first === group.last
        ? DAY_LABELS[group.first]
        : `${DAY_LABELS[group.first]}–${DAY_LABELS[group.last]}`
    return `${days} ${formatWindow(group.opensAt, group.closesAt)}`
  })
}

// ['Mo-Fr 07:00-19:00', 'Sa 08:00-14:00'], the format schema.org asks for.
export function openingHours(hours: OpenDay[]): string[] {
  return groupHours(hours).map((group) => {
    const days =
      group.first === group.last
        ? DAY_CODES[group.first]
        : `${DAY_CODES[group.first]}-${DAY_CODES[group.last]}`
    return `${days} ${group.opensAt.slice(0, 5)}-${group.closesAt.slice(0, 5)}`
  })
}

// Black or white, whichever contrasts more with the background (WCAG relative luminance).
// One of the two always reaches 4.5:1, so text on any brand color passes WCAG AA.
export function textColorOn(hex: string): '#000000' | '#ffffff' {
  const channel = (start: number) => {
    const value = Number.parseInt(hex.slice(start, start + 2), 16) / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
  const onBlack = (luminance + 0.05) / 0.05
  const onWhite = 1.05 / (luminance + 0.05)
  return onBlack >= onWhite ? '#000000' : '#ffffff'
}

// The schema.org block search engines read. Empty lists are left out rather than sent empty.
// Every '<' is escaped, so contractor text can't close the <script> tag it sits in.
function jsonLd({ tenant, site, phone, hours }: PublicSiteData): string {
  const business: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'HVACBusiness',
    name: tenant.name,
    telephone: phone,
    url: siteUrl(tenant.slug),
    address: {
      '@type': 'PostalAddress',
      addressLocality: site.city,
      addressRegion: site.region,
      addressCountry: 'US',
    },
  }
  if (site.citiesServed.length > 0) business.areaServed = site.citiesServed
  const opening = openingHours(hours)
  if (opening.length > 0) business.openingHours = opening
  return JSON.stringify(business).replaceAll('<', '\\u003c')
}
