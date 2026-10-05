import { db, type Tx } from '../../db/client.ts'
import { HttpError } from '../../lib/http-error.ts'
import { formatDay, formatWindow, weekdayOf, weekdaysLabel } from '../../lib/labels.ts'
import { emitToTenant } from '../../realtime/index.ts'
import type { SessionUser } from '../accounts/accounts.service.ts'
import * as audit from '../audit/audit.queries.ts'
import * as charges from '../charges/charges.service.ts'
import * as customers from '../customers/customers.queries.ts'
import { sendBookingConfirmation } from '../homeowner-messages/homeowner-messages.service.ts'
import * as queries from './booking.queries.ts'
import type { OfficeBookingInput } from './booking.schemas.ts'

// Shown next to the office's consent checkbox, and stored with the consent as proof.
// relay-web shows the same sentence (features/dispatch/book-job-dialog.tsx).
export const OFFICE_CONSENT_WORDING =
  'The customer agreed to get texts about this booking, like confirmations and reminders.'

export function listServices(tenantId: string) {
  return queries.listActiveServices(tenantId)
}

type Reserve = { allowOverCap: boolean; excludeJobId?: string }

// Checks that `windowId` can take one more job on local day `date` and returns the job's real
// start and end. Must run inside a transaction: it locks the window until the transaction
// ends, so the office, the web and the AI can never both take the last place.
// The office may go over the cap (`allowOverCap`); online booking and the AI never do.
export async function reserveWindow(
  tx: Tx,
  tenantId: string,
  windowId: string,
  date: string,
  { allowOverCap, excludeJobId }: Reserve,
) {
  const window = await queries.lockWindow(tenantId, windowId, date, tx)
  if (!window) {
    throw new HttpError(
      404,
      'not_found',
      'That arrival window doesn’t exist anymore. Pick another one.',
    )
  }
  const label = formatWindow(window.startsAt, window.endsAt)
  if (window.isPast) throw new HttpError(422, 'past_date', 'Pick today or a later date.')
  const weekday = weekdayOf(date)
  if (window.weekday !== weekday) {
    throw new HttpError(
      422,
      'window_not_offered',
      `The ${label} window isn’t offered on ${weekdaysLabel(weekday)}. Pick another window.`,
    )
  }
  const booked = await queries.countActiveJobsAt(tenantId, window.windowStartsAt, excludeJobId, tx)
  if (booked >= window.jobCap && !allowOverCap) {
    throw new HttpError(
      409,
      'window_full',
      `The ${label} window on ${formatDay(date)} is full (${booked} of ${window.jobCap} booked).`,
    )
  }
  return { windowStartsAt: window.windowStartsAt, windowEndsAt: window.windowEndsAt }
}

// The office books a job for a caller: saves the customer and address if they are new,
// records consent to texts, and puts the job on the board as booked.
export async function bookForOffice(user: SessionUser, input: OfficeBookingInput) {
  const tenantId = tenantOf(user)
  const job = await db.transaction(async (tx) => {
    const slot = await reserveWindow(tx, tenantId, input.windowId, input.date, {
      allowOverCap: input.allowOverCap,
    })
    if (!(await queries.findActiveService(tenantId, input.serviceId, tx))) {
      throw new HttpError(404, 'not_found', 'That service isn’t offered anymore. Pick another one.')
    }

    const customer = input.customerId
      ? await customers.findCustomer(tenantId, input.customerId, tx)
      : await customers.insertCustomer(tenantId, { ...input.newCustomer!, source: 'office' }, tx)
    if (!customer)
      throw new HttpError(404, 'not_found', 'That customer wasn’t found. Search again.')

    const property = input.propertyId
      ? await customers.findProperty(tenantId, customer.id, input.propertyId, tx)
      : await customers.insertProperty(
          tenantId,
          { ...input.newProperty!, customerId: customer.id },
          tx,
        )
    if (!property) {
      throw new HttpError(404, 'not_found', 'That address wasn’t found for this customer.')
    }

    if (input.consentToTexts) {
      if (!customer.phone) {
        throw new HttpError(
          422,
          'no_phone',
          'This customer has no phone number, so they can’t get texts. Add one first.',
        )
      }
      await queries.insertConsent(
        tenantId,
        {
          contact: customer.phone,
          channel: 'sms',
          granted: true,
          source: 'office',
          wording: OFFICE_CONSENT_WORDING,
          createdBy: user.id,
        },
        tx,
      )
      await audit.insertUserAction(
        tenantId,
        {
          actorUserId: user.id,
          action: 'consent.recorded',
          entityType: 'customer',
          entityId: customer.id,
          data: { channel: 'sms', source: 'office' },
        },
        tx,
      )
    }

    const job = await insertBookedJob(
      tenantId,
      {
        customerId: customer.id,
        propertyId: property.id,
        serviceId: input.serviceId,
        status: 'booked',
        source: 'office',
        priority: input.vulnerableOccupant,
        problem: input.problem,
        systemType: input.systemType,
        vulnerableOccupant: input.vulnerableOccupant,
        ...slot,
        createdBy: user.id,
        bookedAt: new Date(),
      },
      tx,
    )
    await audit.insertUserAction(
      tenantId,
      {
        actorUserId: user.id,
        action: 'job.booked',
        entityType: 'job',
        entityId: job.id,
        data: { source: 'office', date: input.date, windowId: input.windowId },
      },
      tx,
    )
    await sendBookingConfirmation(tenantId, job.id, tx)
    return job
  })

  announceBooking(tenantId, job, input.date)
  return { jobId: job.id, date: input.date }
}

// Tells open dashboards about a new booking. Every way of booking calls this after its
// transaction commits (never inside it: a booking that rolls back must not be announced), so
// all of them send the same events.
export function announceBooking(
  tenantId: string,
  job: { id: string; priority: boolean },
  date: string,
) {
  const change = { jobId: job.id, dates: [date] }
  emitToTenant(tenantId, 'booking.created', change)
  if (job.priority) emitToTenant(tenantId, 'booking.priority', change)
}

// Books a job and writes its booked lines (the service, and priority service when chosen) in
// the same transaction. Every way of booking goes through here, so no job is without them.
export async function insertBookedJob(
  tenantId: string,
  values: Parameters<typeof queries.insertJob>[1],
  tx: Tx,
) {
  const job = await queries.insertJob(tenantId, values, tx)
  await charges.addBookedLines(tenantId, job.id, tx)
  return job
}

// Owner and office users always belong to a contractor (a database check guarantees it).
export function tenantOf(user: SessionUser): string {
  if (!user.tenantId) throw new Error(`User ${user.id} has no contractor`)
  return user.tenantId
}
