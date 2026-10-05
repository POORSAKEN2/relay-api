import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, ne, or, sql } from 'drizzle-orm'
import { type Db, db, type Tx } from '../../db/client.ts'
import {
  arrivalWindows,
  consentEvents,
  customers,
  jobs,
  tenants,
  WAITLIST_MAX_MISSED,
  waitlistEntries,
} from '../../db/schema.ts'

// The waitlist and its offers. Tenant-scoped, except the 'waitlist-offers' job's queries
// (closeFinishedEntries, lapseOffers, listTakenOff, listTenantsToOffer), which work on every
// contractor.

const OPEN = ['waiting', 'offered'] as const

// Clears an entry's offer.
export const NO_OFFER = {
  offerWindowId: null,
  offerDate: null,
  offerWindowStartsAt: null,
  offerExpiresAt: null,
  offerLinkHash: null,
}

// Entries that are finished: 14 days are up, the homeowner booked a visit since joining, or
// texted STOP. Returns how many were closed.
export async function closeFinishedEntries() {
  const open = inArray(waitlistEntries.status, OPEN)
  const ended = await db
    .update(waitlistEntries)
    .set({ status: 'expired', ...NO_OFFER })
    .where(and(open, lte(waitlistEntries.endsAt, sql`now()`)))
    .returning({ id: waitlistEntries.id })
  const booked = await db
    .update(waitlistEntries)
    .set({ status: 'booked', ...NO_OFFER })
    .where(
      and(
        open,
        sql`exists (
          select 1 from ${jobs}
          where ${jobs.tenantId} = ${waitlistEntries.tenantId}
            and ${jobs.customerId} = ${waitlistEntries.customerId}
            and ${jobs.status} not in ('cancelled', 'expired')
            and ${jobs.bookedAt} > ${waitlistEntries.createdAt}
        )`,
      ),
    )
    .returning({ id: waitlistEntries.id })
  const stopped = await db
    .update(waitlistEntries)
    .set({ status: 'removed', ...NO_OFFER })
    .where(
      and(
        open,
        sql`(
          select ${consentEvents.granted} from ${consentEvents}
          join ${customers} on ${customers.id} = ${waitlistEntries.customerId}
          where ${consentEvents.tenantId} = ${waitlistEntries.tenantId}
            and ${consentEvents.contact} = ${customers.phone}
            and ${consentEvents.channel} = 'sms'
          order by ${consentEvents.createdAt} desc
          limit 1
        ) = false`,
      ),
    )
    .returning({ id: waitlistEntries.id })
  return ended.length + booked.length + stopped.length
}

// Offers whose 30 minutes are up go back to 'waiting', keeping their place in line, or after
// the last one to 'expired'. The place they missed is kept so it goes to someone else.
export function lapseOffers(tx: Tx) {
  const missed = sql`${waitlistEntries.offersMissed} + 1`
  return tx
    .update(waitlistEntries)
    .set({
      ...NO_OFFER,
      missedWindowStartsAt: sql`${waitlistEntries.offerWindowStartsAt}`,
      offersMissed: missed,
      status: sql`case when ${missed} >= ${WAITLIST_MAX_MISSED} then 'expired' else 'waiting' end`,
    })
    .where(
      and(eq(waitlistEntries.status, 'offered'), lte(waitlistEntries.offerExpiresAt, sql`now()`)),
    )
    .returning({ id: waitlistEntries.id, status: waitlistEntries.status })
}

// Who to tell they are off the waitlist, with what their contractor's text needs.
export function listTakenOff(ids: string[], tx: Tx) {
  if (ids.length === 0) return Promise.resolve([])
  return tx
    .select({
      tenantId: waitlistEntries.tenantId,
      customerId: waitlistEntries.customerId,
      phone: customers.phone,
      tenantName: tenants.name,
      slug: tenants.slug,
      customDomain: tenants.customDomain,
      customDomainVerifiedAt: tenants.customDomainVerifiedAt,
    })
    .from(waitlistEntries)
    .innerJoin(customers, eq(customers.id, waitlistEntries.customerId))
    .innerJoin(tenants, eq(tenants.id, waitlistEntries.tenantId))
    .where(and(inArray(waitlistEntries.id, ids), isNotNull(customers.phone)))
}

// Contractors with homeowners waiting, unless suspended.
export function listTenantsToOffer() {
  return db
    .selectDistinct({
      id: tenants.id,
      name: tenants.name,
      slug: tenants.slug,
      customDomain: tenants.customDomain,
      customDomainVerifiedAt: tenants.customDomainVerifiedAt,
      timezone: tenants.timezone,
      quietHoursStart: tenants.quietHoursStart,
      quietHoursEnd: tenants.quietHoursEnd,
    })
    .from(tenants)
    .innerJoin(
      waitlistEntries,
      and(eq(waitlistEntries.tenantId, tenants.id), eq(waitlistEntries.status, 'waiting')),
    )
    .where(ne(tenants.status, 'suspended'))
}

// Every free place in the next `days` days that starts at least `leadMinutes` from now,
// soonest first. `free` is how many more jobs the window takes on that date.
export async function listOpenPlaces(tenantId: string, days: number, leadMinutes: number) {
  const result = await db.execute<{
    date: string
    windowId: string
    windowStartsAt: string
    windowEndsAt: string
    free: number
  }>(sql`
    select * from (
      select to_char(d.day, 'YYYY-MM-DD') as "date", w.id as "windowId",
        (d.day + w.starts_at) at time zone t.timezone as "windowStartsAt",
        (d.day + w.ends_at) at time zone t.timezone as "windowEndsAt",
        (w.job_cap - (
          select count(*) from jobs j
          where j.tenant_id = t.id
            and j.window_starts_at = (d.day + w.starts_at) at time zone t.timezone
            and j.status not in ('cancelled', 'expired')
        ) - (
          select count(*) from waitlist_entries o
          where o.tenant_id = t.id
            and o.status = 'offered'
            and o.offer_window_starts_at = (d.day + w.starts_at) at time zone t.timezone
            and o.offer_expires_at > now()
        ))::int as "free"
      from tenants t
      cross join generate_series(0, ${days - 1}::int) as n
      cross join lateral (select (now() at time zone t.timezone)::date + n as day) d
      join arrival_windows w on w.tenant_id = t.id and w.weekday = extract(dow from d.day)
      where t.id = ${tenantId}
        and (d.day + w.starts_at) at time zone t.timezone > now() + make_interval(mins => ${leadMinutes}::int)
    ) places
    where free > 0
    order by "windowStartsAt"
  `)
  // Raw queries return timestamps as text.
  return result.rows.map((row) => ({
    ...row,
    windowStartsAt: new Date(row.windowStartsAt),
    windowEndsAt: new Date(row.windowEndsAt),
  }))
}

// The next homeowner in line who hasn't just missed this place: priority first, then whoever
// joined first. Locked, and skipped by another run that has it locked, so two runs never offer
// to the same homeowner.
export async function lockNextWaiting(tenantId: string, startsAt: Date, tx: Tx) {
  const [entry] = await tx
    .select({
      id: waitlistEntries.id,
      customerId: waitlistEntries.customerId,
      phone: customers.phone,
    })
    .from(waitlistEntries)
    .innerJoin(customers, eq(customers.id, waitlistEntries.customerId))
    .where(
      and(
        eq(waitlistEntries.tenantId, tenantId),
        eq(waitlistEntries.status, 'waiting'),
        isNotNull(customers.phone),
        or(
          isNull(waitlistEntries.missedWindowStartsAt),
          ne(waitlistEntries.missedWindowStartsAt, startsAt),
        ),
      ),
    )
    .orderBy(desc(waitlistEntries.priority), asc(waitlistEntries.createdAt))
    .limit(1)
    .for('update', { of: waitlistEntries, skipLocked: true })
  return entry as { id: string; customerId: string; phone: string } | undefined
}

export async function setOffer(
  tenantId: string,
  entryId: string,
  offer: {
    offerWindowId: string
    offerDate: string
    offerWindowStartsAt: Date
    offerExpiresAt: Date
    offerLinkHash: string
  },
  tx: Db,
) {
  await tx
    .update(waitlistEntries)
    .set({ status: 'offered', offeredAt: new Date(), ...offer })
    .where(and(eq(waitlistEntries.tenantId, tenantId), eq(waitlistEntries.id, entryId)))
}

// A homeowner joining again for the same service: their open entry gets the new answers and 14
// more days, and keeps its place in line. False when they have no open entry.
export async function renewOpenEntry(
  tenantId: string,
  customerId: string,
  serviceId: string,
  values: { zip: string; priority: boolean },
  tx: Db,
) {
  const renewed = await tx
    .update(waitlistEntries)
    .set({ ...values, endsAt: sql`now() + interval '14 days'` })
    .where(
      and(
        eq(waitlistEntries.tenantId, tenantId),
        eq(waitlistEntries.customerId, customerId),
        eq(waitlistEntries.serviceId, serviceId),
        inArray(waitlistEntries.status, OPEN),
      ),
    )
    .returning({ id: waitlistEntries.id })
  return renewed.length > 0
}

// An open offer by its link's hash, with what the booking page fills in. Nothing once it ran
// out, was used, or its window was deleted.
export async function findOpenOffer(tenantId: string, linkHash: string, tx: Db = db) {
  const [offer] = await tx
    .select({
      id: waitlistEntries.id,
      serviceId: waitlistEntries.serviceId,
      zip: waitlistEntries.zip,
      priority: waitlistEntries.priority,
      date: waitlistEntries.offerDate,
      windowId: waitlistEntries.offerWindowId,
      expiresAt: waitlistEntries.offerExpiresAt,
      name: customers.name,
      phone: customers.phone,
      startsAt: arrivalWindows.startsAt,
      endsAt: arrivalWindows.endsAt,
    })
    .from(waitlistEntries)
    .innerJoin(customers, eq(customers.id, waitlistEntries.customerId))
    .innerJoin(
      arrivalWindows,
      and(
        eq(arrivalWindows.tenantId, waitlistEntries.tenantId),
        eq(arrivalWindows.id, waitlistEntries.offerWindowId),
      ),
    )
    .where(
      and(
        eq(waitlistEntries.tenantId, tenantId),
        eq(waitlistEntries.offerLinkHash, linkHash),
        eq(waitlistEntries.status, 'offered'),
        gt(waitlistEntries.offerExpiresAt, sql`now()`),
      ),
    )
  return offer
}

// The homeowner booked from their offer.
export async function markOfferBooked(tenantId: string, entryId: string, tx: Db) {
  await tx
    .update(waitlistEntries)
    .set({ status: 'booked', ...NO_OFFER })
    .where(
      and(
        eq(waitlistEntries.tenantId, tenantId),
        eq(waitlistEntries.id, entryId),
        eq(waitlistEntries.status, 'offered'),
      ),
    )
}
