import { randomBytes } from 'node:crypto'
import { type Db, db, type Tx } from '../../db/client.ts'
import {
  type BOOKED_VIA,
  BOOKING_PHOTO_MAX_BYTES,
  type DraftAnswers,
  MAX_BOOKING_PHOTOS,
  type Tenant,
} from '../../db/schema.ts'
import { HttpError } from '../../lib/http-error.ts'
import { photoTypeOf } from '../../lib/image-type.ts'
import { formatDay, formatWindow } from '../../lib/labels.ts'
import { newLinkToken } from '../../lib/link-token.ts'
import { tenantUrl } from '../../lib/tenant-url.ts'
import * as audit from '../audit/audit.queries.ts'
import * as booking from '../booking/booking.queries.ts'
import { announceBooking, insertBookedJob, reserveWindow } from '../booking/booking.service.ts'
import * as calls from '../calls/calls.queries.ts'
import * as customers from '../customers/customers.queries.ts'
import { sendBookingConfirmation } from '../homeowner-messages/homeowner-messages.service.ts'
import { sendText } from '../messaging/sms.ts'
import { zipIsServed } from '../settings/settings.queries.ts'
import * as queries from './online-booking.queries.ts'
import type {
  BookingInput,
  CallbackInput,
  DraftInput,
  WaitlistInput,
} from './online-booking.schemas.ts'
import * as waitlist from './waitlist.queries.ts'
import * as waitlistOffers from './waitlist.service.ts'

// The homeowner's side of booking (flow A). Nobody is signed in: the contractor comes from
// the web address. Steps 1 to 6 end with a booked visit; the homeowner pays at the visit.
// From step 3 on, the answers are kept in a draft, so an unfinished booking can be resumed.

const DAYS_AHEAD = 14

// Recovery text: sent once a draft has been quiet this long, and never for one begun longer
// ago than the cutoff. Still to decide: whether contractors set these themselves.
const RECOVERY_WAIT_MINUTES = 60
const RECOVERY_CUTOFF_HOURS = 24

// Photos on a draft nobody booked are kept this long after its last activity.
const PHOTO_KEEP_DAYS = 30

// A booking counts as won back by a missed-call text only within this many days of the call.
const CALL_LINK_DAYS = 7

// Shown next to the consent checkboxes and stored with the consent as proof. The booking
// page gets them from getOptions, so both sides always use the same words.
// Still to decide: the final wording, after a US telecom lawyer reviews it.
export const CONSENT_WORDING =
  'I agree to get texts and calls about my visit, like confirmations and reminders. Reply STOP to opt out.'
export const WAITLIST_CONSENT_WORDING = 'Text me when a time opens up. Reply STOP to opt out.'

const SERVICE_GONE = 'That service isn’t offered anymore. Pick another one.'
const DRAFT_GONE = 'That saved booking isn’t available anymore. Start a new one.'
const PHOTO_GONE = 'That photo isn’t available anymore.'

// Step 1: what the contractor offers and charges.
export async function getOptions(tenant: Tenant) {
  return {
    services: await queries.listServices(tenant.id),
    priorityFeeCents: tenant.priorityFeeCents,
    consentWording: CONSENT_WORDING,
    waitlistConsentWording: WAITLIST_CONSENT_WORDING,
  }
}

// Step 2: is this ZIP code in the contractor's service area?
export async function checkZip(tenantId: string, zip: string) {
  return { zip, served: await zipIsServed(tenantId, zip) }
}

// Step 5: open arrival windows for the next two weeks, grouped by day. With a waitlist offer's
// token, the place held for that homeowner shows as open.
export async function listOpenWindows(tenantId: string, offerToken?: string) {
  const offerId = await waitlistOffers.findOpenOfferId(tenantId, offerToken)
  const rows = await queries.listOpenWindows(tenantId, DAYS_AHEAD, offerId)
  const days: { date: string; label: string; windows: { id: string; label: string }[] }[] = []
  for (const row of rows) {
    // Rows come sorted by day, so a new date always starts a new group.
    if (days.at(-1)?.date !== row.date) {
      days.push({ date: row.date, label: formatDay(row.date), windows: [] })
    }
    days.at(-1)!.windows.push({ id: row.id, label: formatWindow(row.startsAt, row.endsAt) })
  }
  return { days }
}

// Step 2 exit: someone outside the service area asks the office to call them.
export async function requestCallback(tenantId: string, input: CallbackInput) {
  await queries.insertCallback(tenantId, {
    name: input.name,
    phone: input.phone,
    zip: input.zip,
    message:
      input.message || `Asked for a callback. ZIP code ${input.zip} is outside the service area.`,
    source: 'web',
  })
}

// Step 3: saves who started a booking, so it isn't lost if they stop. Coming back to the step
// with the same draft updates it; no token, or one we don't know, starts a new draft.
export async function saveDraftContact(tenant: Tenant, input: DraftInput, ip: string | null) {
  await checkZipServed(tenant.id, input.zip)
  const contact = {
    name: input.name,
    phone: input.phone,
    zip: input.zip,
    smsConsent: input.consent,
  }

  return db.transaction(async (tx) => {
    const existing = input.token
      ? await queries.findOpenDraft(tenant.id, input.token, tx)
      : undefined
    const token = existing?.token ?? randomBytes(32).toString('hex')

    if (existing) {
      await queries.updateDraft(tenant.id, existing.id, contact, tx)
    } else {
      const draft = await queries.insertDraft(tenant.id, { ...contact, token }, tx)
      await audit.insertHomeownerAction(
        tenant.id,
        {
          action: 'booking_draft.created',
          entityType: 'booking_draft',
          entityId: draft.id,
          data: { zip: input.zip, consent: input.consent },
        },
        tx,
      )
    }

    if (input.consent) {
      await recordConsent(tenant.id, { phone: input.phone, granted: true, ip }, tx)
    } else if (existing?.smsConsent) {
      // They had ticked the box and now unticked it: take the consent back for that number.
      await recordConsent(tenant.id, { phone: existing.phone, granted: false, ip }, tx)
    }
    return { token }
  })
}

// After each later step: replaces the draft's answers.
export async function saveDraftAnswers(tenantId: string, token: string, answers: DraftAnswers) {
  const draft = await queries.findOpenDraft(tenantId, token)
  if (!draft) throw new HttpError(404, 'not_found', DRAFT_GONE)
  await queries.updateDraft(tenantId, draft.id, { answers })
}

// What the wizard needs to pick a draft up again.
export async function getDraft(tenantId: string, token: string) {
  const draft = await queries.findOpenDraft(tenantId, token)
  if (!draft) throw new HttpError(404, 'not_found', DRAFT_GONE)
  return {
    name: draft.name,
    phone: draft.phone,
    zip: draft.zip,
    consent: draft.smsConsent,
    answers: draft.answers,
  }
}

// A draft photo as the wizard gets it. `url` is a path under the API, like a technician's
// photoUrl; the web app puts the API's address in front.
function draftPhoto(token: string, photoId: string) {
  return { id: photoId, url: `/online-booking/drafts/${token}/photos/${photoId}` }
}

// Step 4: a photo of the unit, for a homeowner who isn't sure what they have. Adding one
// counts as activity, like saving answers.
export async function addDraftPhoto(tenantId: string, token: string, body: unknown) {
  const contentType = Buffer.isBuffer(body) ? photoTypeOf(body) : null
  if (!Buffer.isBuffer(body) || !contentType) {
    throw new HttpError(422, 'not_a_photo', 'Pick a JPEG, PNG or WebP photo.')
  }
  if (body.length > BOOKING_PHOTO_MAX_BYTES) {
    throw new HttpError(413, 'photo_too_large', 'That photo is too large. Pick a smaller one.')
  }
  return db.transaction(async (tx) => {
    const draft = await queries.lockOpenDraft(tenantId, token, tx)
    if (!draft) throw new HttpError(404, 'not_found', DRAFT_GONE)
    const photos = await queries.listDraftPhotos(tenantId, draft.id, tx)
    if (photos.length >= MAX_BOOKING_PHOTOS) {
      throw new HttpError(409, 'too_many_photos', `You can add up to ${MAX_BOOKING_PHOTOS} photos.`)
    }
    const photo = await queries.insertDraftPhoto(
      tenantId,
      { draftId: draft.id, contentType, data: body },
      tx,
    )
    await queries.updateDraft(tenantId, draft.id, {}, tx)
    return { photo: draftPhoto(token, photo.id) }
  })
}

export async function listDraftPhotos(tenantId: string, token: string) {
  const draft = await queries.findOpenDraft(tenantId, token)
  if (!draft) throw new HttpError(404, 'not_found', DRAFT_GONE)
  const photos = await queries.listDraftPhotos(tenantId, draft.id)
  return { photos: photos.map((photo) => draftPhoto(token, photo.id)) }
}

// Removing a photo that is already gone is harmless.
export async function removeDraftPhoto(tenantId: string, token: string, photoId: string) {
  const draft = await queries.findOpenDraft(tenantId, token)
  if (!draft) throw new HttpError(404, 'not_found', DRAFT_GONE)
  await queries.deleteDraftPhoto(tenantId, draft.id, photoId)
  await queries.updateDraft(tenantId, draft.id, {})
}

export async function getDraftPhoto(token: string, photoId: string) {
  const photo = await queries.findDraftPhoto(token, photoId)
  if (!photo) throw new HttpError(404, 'not_found', PHOTO_GONE)
  return photo
}

// Step 5 exit: no window works, so the homeowner asks for a text when one opens.
export async function joinWaitlist(tenantId: string, input: WaitlistInput, ip: string | null) {
  await db.transaction(async (tx) => {
    await checkServiceAndZip(tenantId, input.serviceId, input.zip, tx)
    const customer = await findOrAddCustomer(tenantId, input, tx)
    const values = { zip: input.zip, priority: input.vulnerableOccupant }
    if (!(await waitlist.renewOpenEntry(tenantId, customer.id, input.serviceId, values, tx))) {
      await queries.insertWaitlistEntry(
        tenantId,
        { customerId: customer.id, serviceId: input.serviceId, ...values },
        tx,
      )
    }
    await booking.insertConsent(
      tenantId,
      {
        contact: input.phone,
        channel: 'sms',
        granted: true,
        source: 'booking_form',
        wording: WAITLIST_CONSENT_WORDING,
        ip,
      },
      tx,
    )
  })
}

// Where a booking came from, and the consent that came with it.
export type BookingOrigin = {
  source: 'web' | 'text_back' | 'ai'
  callId?: string // the call it came from: the missed call (text_back) or the AI's call
  ip: string | null // web form only
  // The homeowner's yes to texts, kept as proof. null: no yes (box unticked, or the caller
  // said no on the phone), so nothing is recorded and the confirmation text is blocked.
  consent: { source: 'booking_form' | 'call'; wording: string } | null
  draftId?: string // the web draft this booking finishes
  bookedVia?: (typeof BOOKED_VIA)[number] // web form only: where the homeowner found the page
}

// Step 6: the web form's booking. A booking from a missed-call text counts as recovered; any
// other call id (unknown, another contractor's, an answered or old call) is ignored, and so is
// an unknown draft token: a wrong link must never stop a booking.
export async function bookVisit(tenant: Tenant, input: BookingInput, ip: string | null) {
  const draft = input.draftToken
    ? await queries.findOpenDraft(tenant.id, input.draftToken)
    : undefined
  const callId = input.callId ?? draft?.answers.callId
  const since = new Date(Date.now() - CALL_LINK_DAYS * 24 * 3_600_000)
  const call = callId ? await calls.findRecentMissedCall(tenant.id, callId, since) : undefined

  return bookHomeownerVisit(tenant, input, {
    source: call ? 'text_back' : 'web',
    callId: call?.id,
    ip,
    consent: input.consent ? { source: 'booking_form', wording: CONSENT_WORDING } : null,
    draftId: draft?.id,
    // A link's ?from= wins; a booking finished from a draft keeps where the draft began.
    bookedVia: input.bookedVia ?? draft?.answers.bookedVia,
  })
}

// Every homeowner booking (web form, missed-call link, AI on the phone) goes through here, so
// all of them follow the same checks and send the same texts. Saves the homeowner and their
// address, and books the arrival window. There is no online payment: the visit fee and any
// priority fee are paid to the technician at the visit.
export async function bookHomeownerVisit(
  tenant: Tenant,
  input: BookingInput,
  origin: BookingOrigin,
) {
  // The fee applies only when the contractor offers priority service and the homeowner chose it.
  const priorityFeeCents = input.priorityService ? tenant.priorityFeeCents : 0
  // The homeowner's private link to change or cancel; only its hash is stored.
  const manageLink = newLinkToken()

  const job = await db.transaction(async (tx) => {
    await checkServiceAndZip(tenant.id, input.serviceId, input.zip, tx)
    // A place held for this homeowner from the waitlist doesn't count against them.
    const offerId = await waitlistOffers.findOpenOfferId(tenant.id, input.offerToken, tx)
    const slot = await reserveOpenWindow(
      tx,
      tenant.id,
      input.windowId,
      input.date,
      undefined,
      offerId,
    )
    const customer = await findOrAddCustomer(tenant.id, input, tx)
    const property =
      (await customers.findPropertyAt(tenant.id, customer.id, input, tx)) ??
      (await customers.insertProperty(
        tenant.id,
        {
          customerId: customer.id,
          street: input.street,
          unit: input.unit || null,
          city: input.city,
          state: input.state,
          zip: input.zip,
        },
        tx,
      ))

    const job = await insertBookedJob(
      tenant.id,
      {
        customerId: customer.id,
        propertyId: property.id,
        serviceId: input.serviceId,
        status: 'booked',
        bookedAt: new Date(),
        source: origin.source,
        callId: origin.callId,
        bookedVia: origin.bookedVia ?? null,
        priority: input.vulnerableOccupant || priorityFeeCents > 0,
        priorityFeeCents,
        problem: input.problem,
        systemType: input.systemType,
        vulnerableOccupant: input.vulnerableOccupant,
        manageLinkHash: manageLink.hash,
        ...slot,
      },
      tx,
    )

    // Saved before the confirmation, so the compliance gate finds it.
    if (origin.consent) {
      const { source, wording } = origin.consent
      // The form's wording covers texts and calls; the AI's spoken question asks about texts.
      const channels = source === 'booking_form' ? (['sms', 'voice'] as const) : (['sms'] as const)
      for (const channel of channels) {
        await booking.insertConsent(
          tenant.id,
          {
            contact: input.phone,
            channel,
            granted: true,
            source,
            wording,
            jobId: job.id,
            callId: source === 'call' ? origin.callId : undefined,
            ip: origin.ip,
          },
          tx,
        )
      }
    }
    await sendBookingConfirmation(tenant.id, job.id, tx, {
      manageUrl: tenantUrl(tenant, `/manage/${manageLink.token}`),
    })
    // The booking this draft was for is made.
    if (origin.draftId) await queries.markDraftBooked(tenant.id, origin.draftId, job.id, tx)
    if (offerId) await waitlist.markOfferBooked(tenant.id, offerId, tx)

    const event = {
      action: 'job.booked',
      entityType: 'job',
      entityId: job.id,
      data: { source: origin.source, date: input.date, windowId: input.windowId, priorityFeeCents },
    }
    if (origin.source === 'ai') await audit.insertAiAction(tenant.id, event, tx)
    else await audit.insertHomeownerAction(tenant.id, event, tx)
    return job
  })

  // The booking shows on the office's dispatch board right away.
  announceBooking(tenant.id, job, input.date)
  return { jobId: job.id }
}

// Run every minute by the 'hold-expiry' job. Returns how many holds expired. Online booking
// no longer creates holds; this stays for any job that is still 'held'.
export function expireHolds() {
  return queries.expireHolds()
}

// Run daily by the 'booking-photo-cleanup' job. Returns how many photos were deleted.
export function deleteIdlePhotos() {
  return queries.deleteIdleDraftPhotos(new Date(Date.now() - PHOTO_KEEP_DAYS * 24 * 60 * 60_000))
}

// Run every 5 minutes by the 'booking-recovery' job: homeowners who agreed to texts and stopped
// partway get one text with a link back to their draft. Returns how many were texted.
export async function sendRecoveryTexts() {
  const now = Date.now()
  const drafts = await queries.listDraftsToRecover(
    new Date(now - RECOVERY_WAIT_MINUTES * 60_000),
    new Date(now - RECOVERY_CUTOFF_HOURS * 3_600_000),
  )
  for (const draft of drafts) {
    // Together, so a draft is never marked without its text, and never texted twice.
    await db.transaction(async (tx) => {
      await sendText(
        draft.tenantId,
        {
          contact: draft.phone,
          kind: 'abandoned_booking',
          body: `${draft.tenantName}: you started booking a visit. Finish here: ${bookingLink(draft, draft.token)} Reply STOP to opt out.`,
        },
        tx,
      )
      await queries.markDraftTexted(draft.tenantId, draft.id, tx)
    })
  }
  return drafts.length
}

// The address of a contractor's booking page that opens a draft.
function bookingLink(
  tenant: { slug: string; customDomain: string | null; customDomainVerifiedAt: Date | null },
  token: string,
) {
  return tenantUrl(tenant, `/?resume=${token}`)
}

async function checkServiceAndZip(tenantId: string, serviceId: string, zip: string, tx: Db) {
  const service = await booking.findActiveService(tenantId, serviceId, tx)
  if (!service) throw new HttpError(404, 'not_found', SERVICE_GONE)
  await checkZipServed(tenantId, zip, tx)
  return service
}

async function checkZipServed(tenantId: string, zip: string, tx: Db = db) {
  if (!(await zipIsServed(tenantId, zip, tx))) {
    throw new HttpError(422, 'outside_area', `We don’t serve ZIP code ${zip} yet.`)
  }
}

// The consent wording covers texts and calls, so one row is written for each, as proof.
async function recordConsent(
  tenantId: string,
  values: { phone: string; granted: boolean; ip: string | null },
  tx: Db,
) {
  for (const channel of ['sms', 'voice'] as const) {
    await booking.insertConsent(
      tenantId,
      {
        contact: values.phone,
        channel,
        granted: values.granted,
        source: 'booking_form',
        wording: CONSENT_WORDING,
        ip: values.ip,
      },
      tx,
    )
  }
}

// Takes a place in the window like the office does, but never over the cap, never in a window
// that already started, and without telling a homeowner how many jobs are booked.
// `excludeJobId`: a visit being moved doesn't count against its own new window.
// `excludeOfferId`: nor does a place held for the homeowner booking from that offer.
export async function reserveOpenWindow(
  tx: Tx,
  tenantId: string,
  windowId: string,
  date: string,
  excludeJobId?: string,
  excludeOfferId?: string,
) {
  let slot: Awaited<ReturnType<typeof reserveWindow>>
  try {
    slot = await reserveWindow(tx, tenantId, windowId, date, {
      allowOverCap: false,
      excludeJobId,
      excludeOfferId,
    })
  } catch (error) {
    if (error instanceof HttpError && error.code === 'window_full') {
      throw new HttpError(
        409,
        'window_full',
        'That arrival window just filled up. Pick another one.',
      )
    }
    throw error
  }
  if (slot.windowStartsAt <= new Date()) {
    throw new HttpError(
      422,
      'window_started',
      'That arrival window has already started. Pick a later one.',
    )
  }
  return slot
}

// A homeowner who booked or called before keeps one customer record, matched by phone and
// name. Someone else on the same phone (a shared household number) gets their own record, so
// each job shows who booked it.
async function findOrAddCustomer(
  tenantId: string,
  input: { name: string; phone: string; email?: string },
  tx: Db,
) {
  return (
    (await customers.findCustomerByPhoneAndName(tenantId, input.phone, input.name, tx)) ??
    (await customers.insertCustomer(
      tenantId,
      { name: input.name, phone: input.phone, email: input.email, source: 'booking' },
      tx,
    ))
  )
}
