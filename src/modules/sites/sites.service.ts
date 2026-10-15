import type { Site, SitePhotoKind, Tenant } from '../../db/schema.ts'
import { HttpError } from '../../lib/http-error.ts'
import { siteUrl } from '../../lib/tenant-url.ts'
import type { SessionUser } from '../accounts/accounts.service.ts'
import * as audit from '../audit/audit.queries.ts'
import { tenantOf } from '../booking/booking.service.ts'
import {
  findLatestBranding,
  findTenantByHost,
  findTenantById,
} from '../branding/branding.queries.ts'
import { DEFAULT_COLORS } from '../branding/branding.service.ts'
import { renderSite } from './designs/index.ts'
import { buildSiteView, type PublicSiteData } from './site-view.ts'
import * as queries from './sites.queries.ts'
import type { SiteInput } from './sites.schemas.ts'

// What the Website page in the dashboard shows. Every editing route answers with all of it,
// so the page just replaces its copy.
export type SiteEditor = {
  saved: boolean
  liveUrl: string
  publishedAt: Date | null
  site: SiteInput
  reviews: { id: string; authorName: string; place: string | null; rating: number; body: string }[]
  faqs: { id: string; question: string; answer: string }[]
  photos: { id: string; kind: SitePhotoKind; altText: string; url: string }[] // url under the API
}

// The form before the first save. Tenants have no city yet, so the headline names none.
const PREFILL: SiteInput = {
  design: 'breeze',
  headline: 'AC and heating repair, booked online',
  intro: 'Book a visit online in about two minutes, or give us a call.',
  about: null,
  licenseNumber: null,
  city: '',
  region: '',
  citiesServed: [],
  emergencyService: false,
  showPrices: true,
}

function formFields(site: Site): SiteInput {
  return {
    design: site.design,
    headline: site.headline,
    intro: site.intro,
    about: site.about,
    licenseNumber: site.licenseNumber,
    city: site.city,
    region: site.region,
    citiesServed: site.citiesServed,
    emergencyService: site.emergencyService,
    showPrices: site.showPrices,
  }
}

export async function getSiteEditor(tenantId: string): Promise<SiteEditor> {
  const [tenant, site, reviews, faqs, photos] = await Promise.all([
    findTenantById(tenantId),
    queries.findSite(tenantId),
    queries.listReviews(tenantId),
    queries.listFaqs(tenantId),
    queries.listPhotoRefs(tenantId),
  ])
  return {
    saved: site !== undefined,
    liveUrl: siteUrl(tenant!.slug),
    publishedAt: site?.publishedAt ?? null,
    site: site ? formFields(site) : PREFILL,
    reviews: reviews.map(({ id, authorName, place, rating, body }) => ({
      id,
      authorName,
      place,
      rating,
      body,
    })),
    faqs: faqs.map(({ id, question, answer }) => ({ id, question, answer })),
    photos: photos.map((photo) => ({ ...photo, url: `/site/photos/${photo.id}` })),
  }
}

export async function saveSite(user: SessionUser, input: SiteInput): Promise<SiteEditor> {
  const tenantId = tenantOf(user)
  await queries.upsertSite(tenantId, input)
  await recordSiteAction(user, 'site.updated')
  return getSiteEditor(tenantId)
}

// Turns the site on. It needs a saved form and at least one service to show; the phone
// always exists (tenants.contact_phone is required). Publishing again keeps the first date.
export async function publishSite(user: SessionUser): Promise<SiteEditor> {
  const tenantId = tenantOf(user)
  const site = await queries.findSite(tenantId)
  if (!site) throw new HttpError(409, 'site_not_saved', 'Save your website first.')
  const services = await queries.listActiveServices(tenantId)
  if (services.length === 0) {
    throw new HttpError(
      409,
      'site_incomplete',
      'Add at least one service on the Services screen first.',
    )
  }
  if (!site.publishedAt) {
    await queries.setPublishedAt(tenantId, new Date())
    await recordSiteAction(user, 'site.published')
  }
  return getSiteEditor(tenantId)
}

export async function unpublishSite(user: SessionUser): Promise<SiteEditor> {
  const tenantId = tenantOf(user)
  const site = await queries.findSite(tenantId)
  if (site?.publishedAt) {
    await queries.setPublishedAt(tenantId, null)
    await recordSiteAction(user, 'site.unpublished')
  }
  return getSiteEditor(tenantId)
}

// The page as visitors would see it, rendered by the same code, even while the site is off.
export async function renderPreview(tenantId: string): Promise<string> {
  const tenant = await findTenantById(tenantId)
  const data = tenant ? await loadPublicSite(tenant) : undefined
  if (!data) throw new HttpError(409, 'site_not_saved', 'Save your website first.')
  return renderSite(buildSiteView(data))
}

// A site has one row per contractor, so the tenant id is also the site's id.
async function recordSiteAction(user: SessionUser, action: string) {
  const tenantId = tenantOf(user)
  await audit.insertUserAction(tenantId, {
    actorUserId: user.id,
    action,
    entityType: 'site',
    entityId: tenantId,
  })
}

// Everything the contractor's site shows, or undefined when they have never saved the form.
export async function loadPublicSite(tenant: Tenant): Promise<PublicSiteData | undefined> {
  const site = await queries.findSite(tenant.id)
  if (!site) return undefined

  const [number, branding, services, hours, reviews, faqs, photos] = await Promise.all([
    queries.findActiveNumber(tenant.id),
    findLatestBranding(tenant.id),
    queries.listActiveServices(tenant.id),
    queries.listHours(tenant.id),
    queries.listReviews(tenant.id),
    queries.listFaqs(tenant.id),
    queries.listPhotoRefs(tenant.id),
  ])
  return {
    tenant,
    site,
    phone: number ?? tenant.contactPhone,
    branding: {
      primaryColor: branding?.primaryColor ?? DEFAULT_COLORS.primaryColor,
      accentColor: branding?.accentColor ?? DEFAULT_COLORS.accentColor,
      logoAssetId: branding?.logoAssetId ?? null,
      faviconAssetId: branding?.faviconAssetId ?? null,
    },
    services,
    hours,
    reviews,
    faqs,
    photos,
  }
}

// The live site's HTML, or null when there is nothing to show: no such contractor, a
// suspended one, a site never saved, or a site switched off. A contractor still in setup
// may publish, so a shop can see its site live before booking opens.
export async function renderPublicPage(slug: string): Promise<string | null> {
  const tenant = await findTenantByHost({ slug })
  if (!tenant || tenant.status === 'suspended') return null
  const data = await loadPublicSite(tenant)
  if (!data || !data.site.publishedAt) return null
  return renderSite(buildSiteView(data))
}

export async function getPhoto(photoId: string): Promise<{ contentType: string; data: Buffer }> {
  const photo = await queries.findPhotoData(photoId)
  if (!photo) throw new HttpError(404, 'not_found', 'Photo not found.')
  return photo
}
