import { type Db, db } from '../../db/client.ts'
import type { Tenant } from '../../db/schema.ts'
import { HttpError } from '../../lib/http-error.ts'
import { formatDay, formatPhone, formatWindow, textWindow } from '../../lib/labels.ts'
import { hashLinkToken } from '../../lib/link-token.ts'
import { tenantUrl } from '../../lib/tenant-url.ts'
import { hashToken, newToken } from '../../lib/tokens.ts'
import { emitToTenant } from '../../realtime/index.ts'
import * as audit from '../audit/audit.queries.ts'
import * as dispatch from '../dispatch/dispatch.queries.ts'
import { changeStatus } from '../dispatch/dispatch.service.ts'
import { textTechnician } from '../dispatch/technician-texts.ts'
import { queueEmail } from '../messaging/emails.ts'
import { sendText } from '../messaging/sms.ts'
import {
  addressLine,
  cancelledEmail,
  cancelledText,
  changedEmail,
  changedText,
  type VisitChange,
} from './confirmation.ts'
import * as queries from './manage.queries.ts'
import type { RescheduleInput } from './online-booking.schemas.ts'
import { reserveOpenWindow } from './online-booking.service.ts'

// The homeowner's link to change or cancel their visit (sent in the booking confirmation).
// Nobody is signed in: the token finds the visit, and only on its own contractor's address.

type ManagedJob = NonNullable<Awaited<ReturnType<typeof queries.findManagedJob>>>

const linkGone = (tenant: Tenant) =>
  new HttpError(
    404,
    'not_found',
    `This link doesn’t work anymore. Call ${formatPhone(tenant.contactPhone)} to make changes.`,
  )

const cannotChange = (tenant: Tenant) =>
  new HttpError(
    409,
    'cannot_change',
    `Your visit can’t be changed online anymore. Call ${formatPhone(tenant.contactPhone)}.`,
  )

// Online, a visit can change only while it is booked and its window hasn't started. After
// that the technician may be on the way, so the homeowner calls the office.
function changeable(job: { status: string; windowStartsAt: Date }) {
  return job.status === 'booked' && job.windowStartsAt > new Date()
}

async function findJob(tenant: Tenant, token: string, tx: Db = db) {
  const job = await queries.findManagedJob(tenant.id, hashLinkToken(token), tx)
  if (!job) throw linkGone(tenant)
  return job
}

export async function getVisit(tenant: Tenant, token: string) {
  const job = await findJob(tenant, token)
  return {
    status: job.status,
    serviceName: job.serviceName,
    date: job.date,
    windowId: job.windowId,
    dayLabel: formatDay(job.date),
    windowLabel: formatWindow(job.localStart, job.localEnd),
    address: addressLine(job),
    canChange: changeable(job),
    contactPhone: formatPhone(tenant.contactPhone),
  }
}

// Moves the visit to another open window. The technician stays assigned; they are told.
export async function rescheduleVisit(tenant: Tenant, token: string, input: RescheduleInput) {
  const result = await db.transaction(async (tx) => {
    const found = await findJob(tenant, token, tx)
    // Locked, so a double tap or the office moving it at the same time waits its turn.
    const job = await dispatch.lockJob(tenant.id, found.id, tx)
    if (!job || !changeable(job)) throw cannotChange(tenant)
    if (input.date === job.date && input.windowId === job.windowId) return null

    const slot = await reserveOpenWindow(tx, tenant.id, input.windowId, input.date, job.id)
    // A new link with the technician's text: only its hash is kept, so the older one stops
    // working.
    const linkToken = job.technicianId ? newToken(16) : null
    // A new time makes the old arrival time meaningless.
    await dispatch.updateJob(
      tenant.id,
      job.id,
      { ...slot, etaAt: null, ...(linkToken ? { techLinkHash: hashToken(linkToken) } : {}) },
      tx,
    )
    await audit.insertHomeownerAction(
      tenant.id,
      {
        action: 'job.moved',
        entityType: 'job',
        entityId: job.id,
        data: {
          from: { date: job.date, windowId: job.windowId },
          to: { date: input.date, windowId: input.windowId },
        },
      },
      tx,
    )

    const change = visitChange(tenant, found, {
      dayLabel: formatDay(input.date),
      windowLabel: textWindow(slot.windowStartsAt, slot.windowEndsAt, tenant.timezone),
      link: tenantUrl(tenant, `/manage/${token}`),
    })
    await tellHomeowner(tenant.id, found, changedText(change), changedEmail(change), tx)
    if (job.technicianId) {
      await textTechnician(tenant.id, job.id, job.technicianId, 'changed', linkToken, tx)
    }
    return { jobId: job.id, dates: [...new Set([job.date, input.date])] }
  })

  // The board reloads on the same event as an office move.
  if (result) emitToTenant(tenant.id, 'job.assigned', result)
  return getVisit(tenant, token)
}

// Cancels through dispatch's changeStatus, like an office cancel: the status rules, the
// cleared links and the board event all come from there.
export async function cancelVisit(tenant: Tenant, token: string) {
  const job = await findJob(tenant, token)
  let technicianId: string | null = null
  await changeStatus({
    tenantId: tenant.id,
    actor: 'homeowner',
    jobId: job.id,
    to: 'cancelled',
    checkJob: (locked) => {
      if (!changeable(locked)) throw cannotChange(tenant)
      technicianId = locked.technicianId
    },
    afterChange: async (tx) => {
      const change = visitChange(tenant, job, {
        dayLabel: formatDay(job.date),
        windowLabel: textWindow(job.windowStartsAt, job.windowEndsAt, tenant.timezone),
        link: tenantUrl(tenant, '/'),
      })
      await tellHomeowner(tenant.id, job, cancelledText(change), cancelledEmail(change), tx)
      if (technicianId) await textTechnician(tenant.id, job.id, technicianId, 'cancelled', null, tx)
    },
  })
  return { status: 'cancelled' as const }
}

function visitChange(
  tenant: Tenant,
  job: ManagedJob,
  parts: Pick<VisitChange, 'dayLabel' | 'windowLabel' | 'link'>,
): VisitChange {
  return {
    tenantName: tenant.name,
    contactPhone: tenant.contactPhone,
    customerName: job.customerName,
    address: addressLine(job),
    ...parts,
  }
}

// A text when the customer has a phone (sendText applies consent), an email when they have one.
async function tellHomeowner(
  tenantId: string,
  job: ManagedJob,
  text: string,
  email: { subject: string; body: string },
  tx: Db,
) {
  const about = { kind: 'booking_changed' as const, jobId: job.id, customerId: job.customerId }
  if (job.customerPhone) {
    await sendText(tenantId, { ...about, contact: job.customerPhone, body: text }, tx)
  }
  if (job.customerEmail) {
    await queueEmail(tenantId, { ...about, contact: job.customerEmail, ...email }, tx)
  }
}
