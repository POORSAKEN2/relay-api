import type { Tenant } from '../../db/schema.ts'
import { HttpError } from '../../lib/http-error.ts'
import { findLatestBranding, findTenantByHost } from '../branding/branding.queries.ts'
import { DEFAULT_COLORS } from '../branding/branding.service.ts'
import { renderSite } from './designs/index.ts'
import { buildSiteView, type PublicSiteData } from './site-view.ts'
import * as queries from './sites.queries.ts'

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
