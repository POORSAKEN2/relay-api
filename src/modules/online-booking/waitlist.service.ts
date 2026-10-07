import { type Db, db } from '../../db/client.ts'
import { type Tenant, WAITLIST_OFFER_MINUTES } from '../../db/schema.ts'
import { HttpError } from '../../lib/http-error.ts'
import { formatClock, formatDay, formatPhone, formatWindow, textWindow } from '../../lib/labels.ts'
import { hashLinkToken, newLinkToken } from '../../lib/link-token.ts'
import { tenantUrl } from '../../lib/tenant-url.ts'
import * as booking from '../booking/booking.queries.ts'
import { quietUntil } from '../messaging/rules.ts'
import { sendText } from '../messaging/sms.ts'
import * as queries from './waitlist.queries.ts'
import { offerText, takenOffText } from './waitlist-texts.ts'

// The waitlist's side of booking: when a place opens, the next homeowner in line gets a text
// with a link that books it, and the place is held for them for 30 minutes.

const DAYS_AHEAD = 14 // the booking calendar's two weeks
const LEAD_MINUTES = 120 // a technician needs time to get there

type OfferingTenant = Awaited<ReturnType<typeof queries.listTenantsToOffer>>[number]
type Place = Awaited<ReturnType<typeof queries.listOpenPlaces>>[number]

// Run every minute by the 'waitlist-offers' job. Finds openings from the current state, so it
// covers every way a place frees up: a cancel, a move, a bigger window. Returns how many offers
// it made and how many ran out.
export async function sendWaitlistOffers() {
  await queries.closeFinishedEntries()
  const expired = await lapseOffers()
  let offered = 0
  for (const tenant of await queries.listTenantsToOffer()) {
    // An offer at night would run out before anyone reads it.
    if (quietUntil(new Date(), tenant.timezone, tenant.quietHoursStart, tenant.quietHoursEnd)) {
      continue
    }
    offered += await offerOpenPlaces(tenant)
  }
  return { offered, expired }
}

// Offers that ran out, and the last text for those taken off, together.
function lapseOffers() {
  return db.transaction(async (tx) => {
    const lapsed = await queries.lapseOffers(tx)
    const takenOff = lapsed.filter((entry) => entry.status === 'expired').map((entry) => entry.id)
    for (const entry of await queries.listTakenOff(takenOff, tx)) {
      await sendText(
        entry.tenantId,
        {
          contact: entry.phone!,
          kind: 'waitlist_offer',
          customerId: entry.customerId,
          body: takenOffText({ tenantName: entry.tenantName, link: tenantUrl(entry, '/') }),
        },
        tx,
      )
    }
    return lapsed.length
  })
}

async function offerOpenPlaces(tenant: OfferingTenant) {
  let offered = 0
  for (const place of await queries.listOpenPlaces(tenant.id, DAYS_AHEAD, LEAD_MINUTES)) {
    for (let i = 0; i < place.free; i++) {
      // Nobody waiting for this place (everyone left just missed it), or it filled: try the
      // next one.
      if ((await offerPlace(tenant, place)) !== 'offered') break
      offered++
    }
  }
  return offered
}

// One place to one homeowner, with its text. The window is locked as for a booking, so a
// booking at the same moment can't take the place too.
function offerPlace(tenant: OfferingTenant, place: Place) {
  return db.transaction(async (tx): Promise<'offered' | 'full' | 'nobody_waiting'> => {
    const window = await booking.lockWindow(tenant.id, place.windowId, place.date, tx)
    if (!window) return 'full'
    const taken =
      (await booking.countActiveJobsAt(tenant.id, place.windowStartsAt, undefined, tx)) +
      (await booking.countOpenOffersAt(tenant.id, place.windowStartsAt, undefined, tx))
    if (taken >= window.jobCap) return 'full'

    const entry = await queries.lockNextWaiting(tenant.id, place.windowStartsAt, tx)
    if (!entry) return 'nobody_waiting'
    const link = newLinkToken()
    await queries.setOffer(
      tenant.id,
      entry.id,
      {
        offerWindowId: place.windowId,
        offerDate: place.date,
        offerWindowStartsAt: place.windowStartsAt,
        offerExpiresAt: new Date(Date.now() + WAITLIST_OFFER_MINUTES * 60_000),
        offerLinkHash: link.hash,
      },
      tx,
    )
    await sendText(
      tenant.id,
      {
        contact: entry.phone,
        kind: 'waitlist_offer',
        customerId: entry.customerId,
        body: offerText({
          tenantName: tenant.name,
          dayLabel: formatDay(place.date),
          windowLabel: textWindow(place.windowStartsAt, place.windowEndsAt, tenant.timezone),
          link: tenantUrl(tenant, `/?offer=${link.token}`),
        }),
      },
      tx,
    )
    return 'offered'
  })
}

const offerEnded = (tenant: Tenant) =>
  new HttpError(
    404,
    'not_found',
    `This offer has ended. Pick another time, or call ${formatPhone(tenant.contactPhone)}.`,
  )

// The offer link: what the booking page fills in, and until when the place is held.
export async function getOffer(tenant: Tenant, token: string) {
  const offer = await queries.findOpenOffer(tenant.id, hashLinkToken(token))
  if (!offer) throw offerEnded(tenant)
  return {
    serviceId: offer.serviceId,
    zip: offer.zip,
    name: offer.name,
    phone: offer.phone ?? '',
    vulnerableOccupant: offer.priority,
    date: offer.date!,
    windowId: offer.windowId!,
    dayLabel: formatDay(offer.date!),
    windowLabel: formatWindow(offer.startsAt, offer.endsAt),
    heldUntilLabel: formatClock(offer.expiresAt!, tenant.timezone),
  }
}

// The open offer a token names, if any. An ended or unknown token is ignored: it must never
// stop a booking or the calendar.
export async function findOpenOfferId(tenantId: string, token: string | undefined, tx: Db = db) {
  if (!token) return undefined
  return (await queries.findOpenOffer(tenantId, hashLinkToken(token), tx))?.id
}
