import { and, asc, eq, isNull } from 'drizzle-orm'
import { type Db, db } from '../../db/client.ts'
import {
  businessHours,
  phoneNumbers,
  type Site,
  services,
  siteFaqs,
  sitePhotos,
  siteReviews,
  sites,
} from '../../db/schema.ts'

// Tenant-scoped: every query takes tenantId first.

export async function findSite(tenantId: string, tx: Db = db): Promise<Site | undefined> {
  const [site] = await tx.select().from(sites).where(eq(sites.tenantId, tenantId))
  return site
}

type SiteValues = Pick<
  typeof sites.$inferInsert,
  | 'design'
  | 'headline'
  | 'intro'
  | 'about'
  | 'licenseNumber'
  | 'city'
  | 'region'
  | 'citiesServed'
  | 'emergencyService'
  | 'showPrices'
>

// The first save creates the row; later saves change it.
export async function upsertSite(tenantId: string, values: SiteValues, tx: Db = db) {
  await tx
    .insert(sites)
    .values({ ...values, tenantId })
    .onConflictDoUpdate({ target: sites.tenantId, set: { ...values, updatedAt: new Date() } })
}

// null switches the site off.
export async function setPublishedAt(tenantId: string, publishedAt: Date | null, tx: Db = db) {
  await tx.update(sites).set({ publishedAt }).where(eq(sites.tenantId, tenantId))
}

// The contractor's Relay number, so calls from the site reach the AI when nobody answers.
export async function findActiveNumber(tenantId: string, tx: Db = db): Promise<string | undefined> {
  const [row] = await tx
    .select({ number: phoneNumbers.number })
    .from(phoneNumbers)
    .where(and(eq(phoneNumbers.tenantId, tenantId), eq(phoneNumbers.status, 'active')))
    .orderBy(asc(phoneNumbers.createdAt))
    .limit(1)
  return row?.number
}

export function listActiveServices(tenantId: string, tx: Db = db) {
  return tx
    .select({
      name: services.name,
      description: services.description,
      priceType: services.priceType,
      priceCents: services.priceCents,
    })
    .from(services)
    .where(and(eq(services.tenantId, tenantId), isNull(services.archivedAt)))
    .orderBy(asc(services.sortOrder), asc(services.name))
}

export function listHours(tenantId: string, tx: Db = db) {
  return tx
    .select({
      weekday: businessHours.weekday,
      opensAt: businessHours.opensAt,
      closesAt: businessHours.closesAt,
    })
    .from(businessHours)
    .where(eq(businessHours.tenantId, tenantId))
    .orderBy(asc(businessHours.weekday))
}

export function listReviews(tenantId: string, tx: Db = db) {
  return tx
    .select()
    .from(siteReviews)
    .where(eq(siteReviews.tenantId, tenantId))
    .orderBy(asc(siteReviews.sortOrder), asc(siteReviews.createdAt))
}

export function listFaqs(tenantId: string, tx: Db = db) {
  return tx
    .select()
    .from(siteFaqs)
    .where(eq(siteFaqs.tenantId, tenantId))
    .orderBy(asc(siteFaqs.sortOrder), asc(siteFaqs.createdAt))
}

// Photo ids and descriptions only: the bytes are served one at a time by their own route.
export function listPhotoRefs(tenantId: string, tx: Db = db) {
  return tx
    .select({ id: sitePhotos.id, kind: sitePhotos.kind, altText: sitePhotos.altText })
    .from(sitePhotos)
    .where(eq(sitePhotos.tenantId, tenantId))
    .orderBy(asc(sitePhotos.kind), asc(sitePhotos.sortOrder), asc(sitePhotos.createdAt))
}

// Not tenant-scoped: site photos are public, found by their random id.
export async function findPhotoData(id: string) {
  const [photo] = await db
    .select({ contentType: sitePhotos.contentType, data: sitePhotos.data })
    .from(sitePhotos)
    .where(eq(sitePhotos.id, id))
    .limit(1)
  return photo
}
