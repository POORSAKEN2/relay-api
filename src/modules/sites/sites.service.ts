import type { Tenant } from '../../db/schema.ts'
import { findLatestBranding } from '../branding/branding.queries.ts'
import { DEFAULT_COLORS } from '../branding/branding.service.ts'
import type { PublicSiteData } from './site-view.ts'
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
