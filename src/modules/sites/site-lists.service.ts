import { db } from '../../db/client.ts'
import { HttpError } from '../../lib/http-error.ts'
import type { SessionUser } from '../accounts/accounts.service.ts'
import * as audit from '../audit/audit.queries.ts'
import { tenantOf } from '../booking/booking.service.ts'
import * as queries from './sites.queries.ts'
import type { FaqInput, ReviewInput } from './sites.schemas.ts'
import { getSiteEditor, type SiteEditor } from './sites.service.ts'

// The site's reviews and questions. Each change answers with the whole editor, like the
// other site routes.

const LIST_CHANGED = 'Your list changed since this page loaded. Refresh and try again.'

// True when `ids` holds every id of the list exactly once. Anything else means another tab
// added or deleted an item since this page loaded.
function isWholeList(ids: string[], existing: string[]): boolean {
  const given = new Set(ids)
  return (
    given.size === ids.length &&
    given.size === existing.length &&
    existing.every((id) => given.has(id))
  )
}

async function record(user: SessionUser, action: string, entityType: string, entityId?: string) {
  await audit.insertUserAction(tenantOf(user), {
    actorUserId: user.id,
    action,
    entityType,
    entityId,
  })
}

// Reviews

export async function addReview(user: SessionUser, input: ReviewInput): Promise<SiteEditor> {
  const tenantId = tenantOf(user)
  const reviewId = await queries.insertReview(tenantId, input)
  await record(user, 'site.review_added', 'site_review', reviewId)
  return getSiteEditor(tenantId)
}

export async function updateReview(
  user: SessionUser,
  reviewId: string,
  input: ReviewInput,
): Promise<SiteEditor> {
  const tenantId = tenantOf(user)
  const found = await queries.updateReview(tenantId, reviewId, input)
  if (!found) throw new HttpError(404, 'not_found', 'Review not found.')
  await record(user, 'site.review_updated', 'site_review', reviewId)
  return getSiteEditor(tenantId)
}

export async function deleteReview(user: SessionUser, reviewId: string): Promise<SiteEditor> {
  const tenantId = tenantOf(user)
  const found = await queries.deleteReview(tenantId, reviewId)
  if (!found) throw new HttpError(404, 'not_found', 'Review not found.')
  await record(user, 'site.review_deleted', 'site_review', reviewId)
  return getSiteEditor(tenantId)
}

// All or nothing: the list is locked, checked whole, then renumbered in one transaction.
export async function reorderReviews(user: SessionUser, ids: string[]): Promise<SiteEditor> {
  const tenantId = tenantOf(user)
  await db.transaction(async (tx) => {
    const existing = await queries.lockReviewIds(tenantId, tx)
    if (!isWholeList(ids, existing)) throw new HttpError(409, 'list_changed', LIST_CHANGED)
    for (const [sortOrder, reviewId] of ids.entries()) {
      await queries.setReviewOrder(tenantId, reviewId, sortOrder, tx)
    }
    await audit.insertUserAction(
      tenantId,
      { actorUserId: user.id, action: 'site.reviews_reordered', entityType: 'site_review' },
      tx,
    )
  })
  return getSiteEditor(tenantId)
}

// Questions

export async function addFaq(user: SessionUser, input: FaqInput): Promise<SiteEditor> {
  const tenantId = tenantOf(user)
  const faqId = await queries.insertFaq(tenantId, input)
  await record(user, 'site.faq_added', 'site_faq', faqId)
  return getSiteEditor(tenantId)
}

export async function updateFaq(
  user: SessionUser,
  faqId: string,
  input: FaqInput,
): Promise<SiteEditor> {
  const tenantId = tenantOf(user)
  const found = await queries.updateFaq(tenantId, faqId, input)
  if (!found) throw new HttpError(404, 'not_found', 'Question not found.')
  await record(user, 'site.faq_updated', 'site_faq', faqId)
  return getSiteEditor(tenantId)
}

export async function deleteFaq(user: SessionUser, faqId: string): Promise<SiteEditor> {
  const tenantId = tenantOf(user)
  const found = await queries.deleteFaq(tenantId, faqId)
  if (!found) throw new HttpError(404, 'not_found', 'Question not found.')
  await record(user, 'site.faq_deleted', 'site_faq', faqId)
  return getSiteEditor(tenantId)
}

export async function reorderFaqs(user: SessionUser, ids: string[]): Promise<SiteEditor> {
  const tenantId = tenantOf(user)
  await db.transaction(async (tx) => {
    const existing = await queries.lockFaqIds(tenantId, tx)
    if (!isWholeList(ids, existing)) throw new HttpError(409, 'list_changed', LIST_CHANGED)
    for (const [sortOrder, faqId] of ids.entries()) {
      await queries.setFaqOrder(tenantId, faqId, sortOrder, tx)
    }
    await audit.insertUserAction(
      tenantId,
      { actorUserId: user.id, action: 'site.faqs_reordered', entityType: 'site_faq' },
      tx,
    )
  })
  return getSiteEditor(tenantId)
}
