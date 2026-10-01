import { db, type Tx } from '../../db/client.ts'
import { HttpError } from '../../lib/http-error.ts'
import { formatClock, formatDay, formatTime, formatWindow, statusLabel } from '../../lib/labels.ts'
import { emitToTenant } from '../../realtime/index.ts'
import type { SessionUser } from '../accounts/accounts.service.ts'
import * as audit from '../audit/audit.queries.ts'
import { tenantOf } from '../booking/booking.service.ts'
import * as dispatchQueries from '../dispatch/dispatch.queries.ts'
import { arrivalLabel, changeStatus } from '../dispatch/dispatch.service.ts'
import { sendText } from '../messaging/sms.ts'
import * as queries from './technician-jobs.queries.ts'
import { noAccessText, onMyWayText, runningLateText } from './texts.ts'

// The technician's side of jobs: only the jobs the office assigned to them, and the buttons
// that move a visit along. Status rules live in dispatch (changeStatus); this module adds the
// "is it yours" check, arrival times and the homeowner's texts. Photos and payment come in
// later parts of module 8.

const DAYS_SHOWN = 7 // today and the next 6 days
const NOT_YOURS = 'This job isn’t assigned to you anymore.'

type CardRow = Awaited<ReturnType<typeof queries.listTechnicianJobs>>[number]

// A job card as the list shows it.
function toCard({ date, localStart, localEnd, etaLocal, ...job }: CardRow) {
  return {
    ...job,
    dateLabel: formatDay(date),
    windowLabel: formatWindow(localStart, localEnd),
    etaLabel: arrivalLabel(job.status, etaLocal),
  }
}

// Unfinished jobs from earlier days, then the technician's jobs grouped by local day. Days
// without jobs are left out.
export async function listMyJobs(user: SessionUser) {
  const tenantId = tenantOf(user)
  const [earlier, rows] = await Promise.all([
    queries.listEarlierTechnicianJobs(tenantId, user.id),
    queries.listTechnicianJobs(tenantId, user.id, DAYS_SHOWN),
  ])
  const days: { date: string; label: string; jobs: ReturnType<typeof toCard>[] }[] = []
  for (const row of rows) {
    // Rows come sorted by day, so a new date always starts a new group.
    if (days.at(-1)?.date !== row.date) {
      days.push({ date: row.date, label: formatDay(row.date), jobs: [] })
    }
    days.at(-1)!.jobs.push(toCard(row))
  }
  return { earlier: earlier.map(toCard), days }
}

function notYours() {
  return new HttpError(404, 'not_found', NOT_YOURS)
}

// The job, if it's this technician's and still shows on their list. Anything else (another
// technician's, unassigned, another contractor's, cancelled) gets the same 404, so the answer
// doesn't reveal which jobs exist.
async function findMyJob(user: SessionUser, jobId: string) {
  const job = await dispatchQueries.findJobDetail(tenantOf(user), jobId)
  const visible = (queries.VISIBLE_STATUSES as readonly string[]).includes(job?.status ?? '')
  if (!job || job.technicianId !== user.id || !visible) throw notYours()
  return job
}

// Everything the technician needs for the visit. Office-only parts (the schedule, allowed
// status changes, the customer's email, where the booking came from) are left out.
export async function getMyJob(user: SessionUser, jobId: string) {
  const job = await findMyJob(user, jobId)
  const tenantId = tenantOf(user)
  const [notes, photos] = await Promise.all([
    dispatchQueries.listNotes(tenantId, jobId),
    dispatchQueries.listJobPhotos(tenantId, jobId),
  ])
  return {
    job: {
      id: job.id,
      status: job.status,
      priority: job.priority,
      problem: job.problem,
      systemType: job.systemType,
      vulnerableOccupant: job.vulnerableOccupant,
      dateLabel: formatDay(job.date),
      windowLabel: formatWindow(job.localStart, job.localEnd),
      etaLabel: arrivalLabel(job.status, job.etaLocal),
      completedLabel: job.completedLocal ? formatTime(job.completedLocal) : null,
      service: { name: job.service.name },
      customer: { name: job.customer.name, phone: job.customer.phone },
      property: job.property,
    },
    notes,
    // `url` is a path under the API; the web app puts the API's address in front.
    photos: photos.map((photo) => ({ id: photo.id, url: `/my-jobs/${jobId}/photos/${photo.id}` })),
  }
}

// A photo the homeowner added while booking one of this technician's jobs.
export async function getMyJobPhoto(user: SessionUser, jobId: string, photoId: string) {
  await findMyJob(user, jobId)
  const photo = await dispatchQueries.findJobPhoto(tenantOf(user), jobId, photoId)
  if (!photo) throw new HttpError(404, 'not_found', 'That photo isn’t on this job.')
  return photo
}

// An arrival time `minutes` from now.
function arrivalIn(minutes: number): Date {
  return new Date(Date.now() + minutes * 60 * 1000)
}

// Saves a text to the job's homeowner in the caller's transaction, so the change and the text
// are saved together or not at all. A homeowner without a phone gets none; the change stands.
async function textHomeowner(
  tenantId: string,
  jobId: string,
  kind: 'on_my_way' | 'running_late' | 'no_access',
  body: (contact: queries.JobContact) => string,
  tx: Tx,
) {
  const contact = await queries.findJobContact(tenantId, jobId, tx)
  if (!contact.customerPhone) return
  await sendText(
    tenantId,
    {
      contact: contact.customerPhone,
      kind,
      body: body(contact),
      jobId,
      customerId: contact.customerId,
    },
    tx,
  )
}

// A technician's status button: checks the job is theirs, then changes it through dispatch,
// where the status rules live. Answers with the refreshed job page.
async function changeMyJob(
  user: SessionUser,
  jobId: string,
  to: 'en_route' | 'in_progress' | 'no_access' | 'done',
  extras: { etaAt?: Date; afterChange?: (tx: Tx) => Promise<void> } = {},
) {
  await findMyJob(user, jobId)
  await changeStatus({
    tenantId: tenantOf(user),
    actorUserId: user.id,
    jobId,
    to,
    ...extras,
    // The office may have reassigned the job since the check above.
    checkJob: (job) => {
      if (job.technicianId !== user.id) throw notYours()
    },
  })
  return getMyJob(user, jobId)
}

export function onMyWay(user: SessionUser, jobId: string, minutes: number) {
  const etaAt = arrivalIn(minutes)
  return changeMyJob(user, jobId, 'en_route', {
    etaAt,
    afterChange: (tx) =>
      textHomeowner(
        tenantOf(user),
        jobId,
        'on_my_way',
        (contact) => onMyWayText(contact, formatClock(etaAt, contact.timezone)),
        tx,
      ),
  })
}

export function startJob(user: SessionUser, jobId: string) {
  return changeMyJob(user, jobId, 'in_progress')
}

// No access: the optional note goes on the job under the technician's name, and the
// homeowner hears that the office will call.
export function noAccess(user: SessionUser, jobId: string, note: string) {
  const tenantId = tenantOf(user)
  return changeMyJob(user, jobId, 'no_access', {
    afterChange: async (tx) => {
      if (note) {
        await dispatchQueries.insertNote(tenantId, { jobId, authorId: user.id, body: note }, tx)
      }
      await textHomeowner(
        tenantId,
        jobId,
        'no_access',
        (contact) => noAccessText(contact, formatClock(new Date(), contact.timezone)),
        tx,
      )
    },
  })
}

export function completeJob(user: SessionUser, jobId: string) {
  return changeMyJob(user, jobId, 'done')
}

// Running late moves the arrival time, not the status, so it doesn't go through
// changeStatus(). It still locks the job, so it can't race the office.
export async function runningLate(user: SessionUser, jobId: string, minutes: number) {
  await findMyJob(user, jobId)
  const tenantId = tenantOf(user)
  const etaAt = arrivalIn(minutes)
  const date = await db.transaction(async (tx) => {
    const job = await dispatchQueries.lockJob(tenantId, jobId, tx)
    if (!job || job.technicianId !== user.id) throw notYours()
    if (job.status !== 'booked' && job.status !== 'en_route') {
      throw new HttpError(
        422,
        'invalid_transition',
        `This job is ${statusLabel(job.status)}, so it can’t be running late.`,
      )
    }
    await dispatchQueries.updateJob(tenantId, jobId, { etaAt }, tx)
    await audit.insertUserAction(
      tenantId,
      {
        actorUserId: user.id,
        action: 'job.eta_changed',
        entityType: 'job',
        entityId: jobId,
        data: { etaAt: etaAt.toISOString(), minutes },
      },
      tx,
    )
    await textHomeowner(
      tenantId,
      jobId,
      'running_late',
      (contact) => runningLateText(contact, formatClock(etaAt, contact.timezone)),
      tx,
    )
    return job.date
  })
  // The board and the technician's pages reload on this event and show the new time.
  emitToTenant(tenantId, 'job.status_changed', { jobId, dates: [date] })
  return getMyJob(user, jobId)
}
