import { and, asc, eq, gt, inArray, isNull, lt, ne, sql } from 'drizzle-orm'
import { type Db, db } from '../../db/client.ts'
import {
  bookingDrafts,
  bookingPhotos,
  callbackRequests,
  customers,
  jobs,
  services,
  tenants,
  waitlistEntries,
} from '../../db/schema.ts'

// Tenant-scoped: every query takes tenantId first, except the system jobs' queries
// (expireHolds, listDraftsToRecover, deleteIdleDraftPhotos) and findDraftPhoto, which work
// across contractors.

// Active services in the order the contractor set, with what the booking page shows.
export function listServices(tenantId: string) {
  return db
    .select({
      id: services.id,
      name: services.name,
      description: services.description,
      priceType: services.priceType,
      priceCents: services.priceCents,
    })
    .from(services)
    .where(and(eq(services.tenantId, tenantId), isNull(services.archivedAt)))
    .orderBy(asc(services.sortOrder), asc(services.name))
}

// Arrival windows a homeowner can still take on the contractor's next `days` local days:
// not started yet, and with a place left. Soonest first.
// 'cancelled' and 'expired' jobs hold no place (INACTIVE_STATUSES in booking.queries.ts).
export async function listOpenWindows(tenantId: string, days: number) {
  const result = await db.execute<{ date: string; id: string; startsAt: string; endsAt: string }>(
    sql`
      select to_char(d.day, 'YYYY-MM-DD') as "date", w.id, w.starts_at as "startsAt", w.ends_at as "endsAt"
      from tenants t
      cross join generate_series(0, ${days - 1}::int) as n
      cross join lateral (select (now() at time zone t.timezone)::date + n as day) d
      join arrival_windows w on w.tenant_id = t.id and w.weekday = extract(dow from d.day)
      where t.id = ${tenantId}
        and (d.day + w.starts_at) at time zone t.timezone > now()
        and w.job_cap > (
          select count(*) from jobs j
          where j.tenant_id = t.id
            and j.window_starts_at = (d.day + w.starts_at) at time zone t.timezone
            and j.status not in ('cancelled', 'expired')
        )
      order by d.day, w.starts_at
    `,
  )
  return result.rows
}

export async function insertCallback(
  tenantId: string,
  values: Omit<typeof callbackRequests.$inferInsert, 'tenantId'>,
) {
  await db.insert(callbackRequests).values({ ...values, tenantId })
}

export async function insertWaitlistEntry(
  tenantId: string,
  values: Omit<typeof waitlistEntries.$inferInsert, 'tenantId'>,
  tx: Db = db,
) {
  await tx.insert(waitlistEntries).values({ ...values, tenantId })
}

export async function insertDraft(
  tenantId: string,
  values: Omit<typeof bookingDrafts.$inferInsert, 'tenantId'>,
  tx: Db = db,
) {
  const [draft] = await tx
    .insert(bookingDrafts)
    .values({ ...values, tenantId })
    .returning()
  return draft
}

// The draft behind a token, unless its booking was already made.
export async function findOpenDraft(tenantId: string, token: string, tx: Db = db) {
  const [draft] = await tx
    .select()
    .from(bookingDrafts)
    .where(
      and(
        eq(bookingDrafts.tenantId, tenantId),
        eq(bookingDrafts.token, token),
        isNull(bookingDrafts.bookedJobId),
      ),
    )
  return draft
}

// Like findOpenDraft, and locks the draft until the transaction ends, so two uploads at once
// can't both take the last photo place.
export async function lockOpenDraft(tenantId: string, token: string, tx: Db) {
  const [draft] = await tx
    .select()
    .from(bookingDrafts)
    .where(
      and(
        eq(bookingDrafts.tenantId, tenantId),
        eq(bookingDrafts.token, token),
        isNull(bookingDrafts.bookedJobId),
      ),
    )
    .for('update')
  return draft
}

// Something the homeowner changed. It counts as activity, which restarts the recovery wait.
export async function updateDraft(
  tenantId: string,
  draftId: string,
  values: Partial<
    Pick<typeof bookingDrafts.$inferInsert, 'name' | 'phone' | 'zip' | 'smsConsent' | 'answers'>
  >,
  tx: Db = db,
) {
  await tx
    .update(bookingDrafts)
    .set({ ...values, lastActivityAt: new Date() })
    .where(and(eq(bookingDrafts.tenantId, tenantId), eq(bookingDrafts.id, draftId)))
}

export async function markDraftBooked(tenantId: string, draftId: string, jobId: string, tx: Db) {
  await tx
    .update(bookingDrafts)
    .set({ bookedJobId: jobId })
    .where(and(eq(bookingDrafts.tenantId, tenantId), eq(bookingDrafts.id, draftId)))
}

// The draft's photos, oldest first.
export function listDraftPhotos(tenantId: string, draftId: string, tx: Db = db) {
  return tx
    .select({ id: bookingPhotos.id })
    .from(bookingPhotos)
    .where(and(eq(bookingPhotos.tenantId, tenantId), eq(bookingPhotos.draftId, draftId)))
    .orderBy(asc(bookingPhotos.createdAt))
}

export async function insertDraftPhoto(
  tenantId: string,
  values: Pick<typeof bookingPhotos.$inferInsert, 'draftId' | 'contentType' | 'data'>,
  tx: Db,
) {
  const [photo] = await tx
    .insert(bookingPhotos)
    .values({ ...values, tenantId })
    .returning({ id: bookingPhotos.id })
  return photo
}

export async function deleteDraftPhoto(tenantId: string, draftId: string, photoId: string) {
  await db
    .delete(bookingPhotos)
    .where(
      and(
        eq(bookingPhotos.tenantId, tenantId),
        eq(bookingPhotos.draftId, draftId),
        eq(bookingPhotos.id, photoId),
      ),
    )
}

// A photo's image, found by its draft's token alone (tokens are unique across Relay). Only
// while the draft is open.
export async function findDraftPhoto(token: string, photoId: string) {
  const [photo] = await db
    .select({ contentType: bookingPhotos.contentType, data: bookingPhotos.data })
    .from(bookingPhotos)
    .innerJoin(
      bookingDrafts,
      and(
        eq(bookingDrafts.tenantId, bookingPhotos.tenantId),
        eq(bookingDrafts.id, bookingPhotos.draftId),
      ),
    )
    .where(
      and(
        eq(bookingDrafts.token, token),
        isNull(bookingDrafts.bookedJobId),
        eq(bookingPhotos.id, photoId),
      ),
    )
  return photo
}

// Every turned-on contractor's drafts that are due their one recovery text: consent given,
// nothing from the homeowner since `quietSince`, begun after `startedAfter`, not booked, not
// texted yet, and no job made for that phone since the draft began (they may have called the
// office instead).
export function listDraftsToRecover(quietSince: Date, startedAfter: Date) {
  return db
    .select({
      id: bookingDrafts.id,
      tenantId: bookingDrafts.tenantId,
      token: bookingDrafts.token,
      phone: bookingDrafts.phone,
      tenantName: tenants.name,
      slug: tenants.slug,
      customDomain: tenants.customDomain,
      customDomainVerifiedAt: tenants.customDomainVerifiedAt,
    })
    .from(bookingDrafts)
    .innerJoin(tenants, eq(tenants.id, bookingDrafts.tenantId))
    .where(
      and(
        ne(tenants.status, 'suspended'),
        eq(bookingDrafts.smsConsent, true),
        isNull(bookingDrafts.bookedJobId),
        isNull(bookingDrafts.recoveryTextedAt),
        lt(bookingDrafts.lastActivityAt, quietSince),
        gt(bookingDrafts.createdAt, startedAfter),
        sql`not exists (
          select 1 from ${jobs}
          join ${customers} on ${customers.id} = ${jobs.customerId}
          where ${jobs.tenantId} = ${bookingDrafts.tenantId}
            and ${customers.phone} = ${bookingDrafts.phone}
            and ${jobs.createdAt} > ${bookingDrafts.createdAt}
        )`,
      ),
    )
}

export async function markDraftTexted(tenantId: string, draftId: string, tx: Db) {
  await tx
    .update(bookingDrafts)
    .set({ recoveryTextedAt: new Date() })
    .where(and(eq(bookingDrafts.tenantId, tenantId), eq(bookingDrafts.id, draftId)))
}

// Every contractor's holds that ran out of time: they stop taking a place in their window.
// Returns how many expired.
export async function expireHolds() {
  const expired = await db
    .update(jobs)
    .set({ status: 'expired', techLinkHash: null, manageLinkHash: null })
    .where(and(eq(jobs.status, 'held'), lt(jobs.holdExpiresAt, new Date())))
    .returning({ id: jobs.id })
  return expired.length
}

// Every contractor's photos on drafts that were never booked and quiet since `idleSince`.
// Returns how many were deleted.
export async function deleteIdleDraftPhotos(idleSince: Date) {
  const idleDrafts = db
    .select({ id: bookingDrafts.id })
    .from(bookingDrafts)
    .where(and(isNull(bookingDrafts.bookedJobId), lt(bookingDrafts.lastActivityAt, idleSince)))
  const deleted = await db
    .delete(bookingPhotos)
    .where(inArray(bookingPhotos.draftId, idleDrafts))
    .returning({ id: bookingPhotos.id })
  return deleted.length
}
