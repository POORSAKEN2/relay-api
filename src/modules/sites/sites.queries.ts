import { and, asc, count, eq, isNull, sql } from 'drizzle-orm'
import { type Db, db, type Tx } from '../../db/client.ts'
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

// Reviews. A new one goes at the end of the list.

type ReviewValues = Pick<
  typeof siteReviews.$inferInsert,
  'authorName' | 'place' | 'rating' | 'body'
>

const isReviewOf = (tenantId: string, reviewId: string) =>
  and(eq(siteReviews.tenantId, tenantId), eq(siteReviews.id, reviewId))

export async function insertReview(tenantId: string, values: ReviewValues): Promise<string> {
  const endOfList = sql<number>`(select coalesce(max(r.sort_order), -1) + 1 from site_reviews r where r.tenant_id = ${tenantId})`
  const [row] = await db
    .insert(siteReviews)
    .values({ ...values, tenantId, sortOrder: endOfList })
    .returning({ id: siteReviews.id })
  return row.id
}

// True when the review was found (and changed).
export async function updateReview(tenantId: string, reviewId: string, values: ReviewValues) {
  const rows = await db
    .update(siteReviews)
    .set(values)
    .where(isReviewOf(tenantId, reviewId))
    .returning({ id: siteReviews.id })
  return rows.length > 0
}

// True when the review was found (and deleted).
export async function deleteReview(tenantId: string, reviewId: string) {
  const rows = await db
    .delete(siteReviews)
    .where(isReviewOf(tenantId, reviewId))
    .returning({ id: siteReviews.id })
  return rows.length > 0
}

// Locks the contractor's reviews until the transaction ends, so a reorder sees the whole list.
export async function lockReviewIds(tenantId: string, tx: Tx): Promise<string[]> {
  const rows = await tx
    .select({ id: siteReviews.id })
    .from(siteReviews)
    .where(eq(siteReviews.tenantId, tenantId))
    .for('update')
  return rows.map((row) => row.id)
}

export async function setReviewOrder(
  tenantId: string,
  reviewId: string,
  sortOrder: number,
  tx: Tx,
) {
  await tx.update(siteReviews).set({ sortOrder }).where(isReviewOf(tenantId, reviewId))
}

// Questions. Same shape as reviews.

type FaqValues = Pick<typeof siteFaqs.$inferInsert, 'question' | 'answer'>

const isFaqOf = (tenantId: string, faqId: string) =>
  and(eq(siteFaqs.tenantId, tenantId), eq(siteFaqs.id, faqId))

export async function insertFaq(tenantId: string, values: FaqValues): Promise<string> {
  const endOfList = sql<number>`(select coalesce(max(f.sort_order), -1) + 1 from site_faqs f where f.tenant_id = ${tenantId})`
  const [row] = await db
    .insert(siteFaqs)
    .values({ ...values, tenantId, sortOrder: endOfList })
    .returning({ id: siteFaqs.id })
  return row.id
}

export async function updateFaq(tenantId: string, faqId: string, values: FaqValues) {
  const rows = await db
    .update(siteFaqs)
    .set(values)
    .where(isFaqOf(tenantId, faqId))
    .returning({ id: siteFaqs.id })
  return rows.length > 0
}

export async function deleteFaq(tenantId: string, faqId: string) {
  const rows = await db
    .delete(siteFaqs)
    .where(isFaqOf(tenantId, faqId))
    .returning({ id: siteFaqs.id })
  return rows.length > 0
}

export async function lockFaqIds(tenantId: string, tx: Tx): Promise<string[]> {
  const rows = await tx
    .select({ id: siteFaqs.id })
    .from(siteFaqs)
    .where(eq(siteFaqs.tenantId, tenantId))
    .for('update')
  return rows.map((row) => row.id)
}

export async function setFaqOrder(tenantId: string, faqId: string, sortOrder: number, tx: Tx) {
  await tx.update(siteFaqs).set({ sortOrder }).where(isFaqOf(tenantId, faqId))
}

// Photos

export async function insertPhoto(
  tenantId: string,
  values: Omit<typeof sitePhotos.$inferInsert, 'tenantId' | 'id' | 'createdAt'>,
  tx: Db = db,
): Promise<string> {
  const [row] = await tx
    .insert(sitePhotos)
    .values({ ...values, tenantId })
    .returning({ id: sitePhotos.id })
  return row.id
}

export async function deleteHeroPhoto(tenantId: string, tx: Db = db) {
  await tx
    .delete(sitePhotos)
    .where(and(eq(sitePhotos.tenantId, tenantId), eq(sitePhotos.kind, 'hero')))
}

export async function countWorkPhotos(tenantId: string, tx: Db = db): Promise<number> {
  const [row] = await tx
    .select({ count: count() })
    .from(sitePhotos)
    .where(and(eq(sitePhotos.tenantId, tenantId), eq(sitePhotos.kind, 'work')))
  return row.count
}

// True when the photo was found (and deleted).
export async function deletePhoto(tenantId: string, photoId: string) {
  const rows = await db
    .delete(sitePhotos)
    .where(and(eq(sitePhotos.tenantId, tenantId), eq(sitePhotos.id, photoId)))
    .returning({ id: sitePhotos.id })
  return rows.length > 0
}
