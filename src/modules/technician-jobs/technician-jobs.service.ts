import { db, type Tx } from '../../db/client.ts'
import {
  JOB_PHOTO_MAX_BYTES,
  MAX_JOB_PHOTOS_PER_STAGE,
  type PHOTO_STAGES,
} from '../../db/schema.ts'
import { HttpError } from '../../lib/http-error.ts'
import { photoTypeOf } from '../../lib/image-type.ts'
import {
  formatClock,
  formatDate,
  formatDay,
  formatTime,
  formatWindow,
  statusLabel,
} from '../../lib/labels.ts'
import { emitToTenant } from '../../realtime/index.ts'
import type { SessionUser } from '../accounts/accounts.service.ts'
import * as audit from '../audit/audit.queries.ts'
import { tenantOf } from '../booking/booking.service.ts'
import * as catalog from '../catalog/catalog.service.ts'
import * as charges from '../charges/charges.service.ts'
import * as dispatchQueries from '../dispatch/dispatch.queries.ts'
import { arrivalLabel, changeStatus, groupWorkPhotos } from '../dispatch/dispatch.service.ts'
import { sendText } from '../messaging/sms.ts'
import * as queries from './technician-jobs.queries.ts'
import { noAccessText, onMyWayText, runningLateText } from './texts.ts'

// The technician's side of jobs: only the jobs the office assigned to them, and the buttons
// that move a visit along. Status rules live in dispatch (changeStatus); this module adds the
// "is it yours" check, arrival times, the homeowner's texts and the technician's own photos.

const DAYS_SHOWN = 7 // today and the next 6 days
const HISTORY_SHOWN = 10 // past visits on the job page
const NOT_YOURS = 'This job isn’t assigned to you anymore.'

type PhotoStage = (typeof PHOTO_STAGES)[number]

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

// The latest finished visits at this address, each with the repairs the homeowner approved.
async function listHistory(tenantId: string, jobId: string) {
  const visits = await queries.listPastVisits(tenantId, jobId, HISTORY_SHOWN)
  const repairs = await queries.listApprovedRepairs(
    tenantId,
    visits.map((visit) => visit.id),
  )
  return visits.map((visit) => ({
    id: visit.id,
    dateLabel: formatDate(visit.date),
    serviceName: visit.serviceName,
    // 'Capacitor replacement', or 'Contactor replacement ×2' for more than one.
    repairs: repairs
      .filter((repair) => repair.jobId === visit.id)
      .map((repair) =>
        repair.quantity > 1 ? `${repair.description} ×${repair.quantity}` : repair.description,
      ),
  }))
}

// Everything the technician needs for the visit. Office-only parts (the schedule, allowed
// status changes, the customer's email, where the booking came from) are left out.
export async function getMyJob(user: SessionUser, jobId: string) {
  const job = await findMyJob(user, jobId)
  const tenantId = tenantOf(user)
  const [notes, photos, workPhotos, timezone, jobCharges, history] = await Promise.all([
    dispatchQueries.listNotes(tenantId, jobId),
    dispatchQueries.listJobPhotos(tenantId, jobId),
    dispatchQueries.listWorkPhotos(tenantId, jobId),
    dispatchQueries.findTimezone(tenantId),
    charges.getCharges(tenantId, jobId),
    listHistory(tenantId, jobId),
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
      // The contractor's time zone: the minutes sheet shows arrival times in it, so they match
      // the homeowner's text even when the phone is set to another zone.
      timezone,
      service: { name: job.service.name },
      customer: { name: job.customer.name, phone: job.customer.phone },
      property: job.property,
    },
    notes,
    // `url` is a path under the API; the web app puts the API's address in front.
    photos: photos.map((photo) => ({ id: photo.id, url: `/my-jobs/${jobId}/photos/${photo.id}` })),
    // The technician's own before and after shots, kept apart from the homeowner's.
    workPhotos: groupWorkPhotos(workPhotos, `/my-jobs/${jobId}/work-photos`),
    charges: jobCharges,
    history,
  }
}

// A photo the homeowner added while booking one of this technician's jobs.
export async function getMyJobPhoto(user: SessionUser, jobId: string, photoId: string) {
  await findMyJob(user, jobId)
  const photo = await dispatchQueries.findJobPhoto(tenantOf(user), jobId, photoId)
  if (!photo) throw new HttpError(404, 'not_found', 'That photo isn’t on this job.')
  return photo
}

// Photos change only while the technician is at the unit with the visit started. Before that
// there is nothing to photograph; after it the visit is a finished record.
function checkPhotosOpen(status: string) {
  if (status === 'in_progress') return
  if (status === 'booked' || status === 'en_route') {
    throw new HttpError(422, 'photos_not_open', 'Start the visit before adding photos.')
  }
  throw new HttpError(422, 'photos_closed', 'This visit is finished, so its photos can’t change.')
}

// A photo the technician takes on the visit. The bytes decide the type, and the job row is
// locked while counting, so two quick uploads can't both take the last place in a stage.
export async function addWorkPhoto(
  user: SessionUser,
  jobId: string,
  stage: PhotoStage,
  body: unknown,
) {
  const contentType = Buffer.isBuffer(body) ? photoTypeOf(body) : null
  if (!Buffer.isBuffer(body) || !contentType) {
    throw new HttpError(422, 'not_a_photo', 'Pick a JPEG, PNG or WebP photo.')
  }
  if (body.length > JOB_PHOTO_MAX_BYTES) {
    throw new HttpError(413, 'photo_too_large', 'That photo is too large. Pick a smaller one.')
  }
  await findMyJob(user, jobId)
  const tenantId = tenantOf(user)
  await db.transaction(async (tx) => {
    const job = await dispatchQueries.lockJob(tenantId, jobId, tx)
    if (!job || job.technicianId !== user.id) throw notYours()
    checkPhotosOpen(job.status)
    const photos = await dispatchQueries.listWorkPhotos(tenantId, jobId, tx)
    if (photos.filter((photo) => photo.stage === stage).length >= MAX_JOB_PHOTOS_PER_STAGE) {
      throw new HttpError(
        409,
        'too_many_photos',
        `You can add up to ${MAX_JOB_PHOTOS_PER_STAGE} ${stage} photos.`,
      )
    }
    await dispatchQueries.insertWorkPhoto(
      tenantId,
      { jobId, stage, contentType, data: body, uploadedBy: user.id },
      tx,
    )
  })
  return getMyJob(user, jobId)
}

// Removing a photo that is already gone is harmless.
export async function removeWorkPhoto(user: SessionUser, jobId: string, photoId: string) {
  await findMyJob(user, jobId)
  const tenantId = tenantOf(user)
  await db.transaction(async (tx) => {
    const job = await dispatchQueries.lockJob(tenantId, jobId, tx)
    if (!job || job.technicianId !== user.id) throw notYours()
    checkPhotosOpen(job.status)
    await dispatchQueries.deleteWorkPhoto(tenantId, jobId, photoId, tx)
  })
  return getMyJob(user, jobId)
}

// A photo the technician took on one of their own jobs.
export async function getWorkPhoto(user: SessionUser, jobId: string, photoId: string) {
  await findMyJob(user, jobId)
  const photo = await dispatchQueries.findWorkPhoto(tenantOf(user), jobId, photoId)
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

// The price list a technician picks repairs from.
export function listPriceList(user: SessionUser) {
  return catalog.listActivePriceItems(tenantOf(user))
}

// Repairs on one of the technician's own jobs. Each checks the job is theirs, changes it
// through charges (where the rules live), and answers with the refreshed job page.
async function changeMyRepairs(
  user: SessionUser,
  jobId: string,
  change: (
    actor: { tenantId: string; userId: string },
    checkJob: (job: { technicianId: string | null }) => void,
  ) => Promise<void>,
) {
  await findMyJob(user, jobId)
  await change({ tenantId: tenantOf(user), userId: user.id }, (job) => {
    // The office may have reassigned the job since the check above.
    if (job.technicianId !== user.id) throw notYours()
  })
  return getMyJob(user, jobId)
}

export function addRepair(
  user: SessionUser,
  jobId: string,
  input: { priceItemId: string; quantity: number },
) {
  return changeMyRepairs(user, jobId, (actor, checkJob) =>
    charges.proposeRepair(actor, jobId, input, checkJob),
  )
}

export function removeRepair(user: SessionUser, jobId: string, itemId: string) {
  return changeMyRepairs(user, jobId, (actor, checkJob) =>
    charges.removeRepair(actor, jobId, itemId, checkJob),
  )
}

export function decideRepairs(user: SessionUser, jobId: string, decision: 'approved' | 'declined') {
  return changeMyRepairs(user, jobId, (actor, checkJob) =>
    charges.decideRepairs(actor, jobId, decision, checkJob),
  )
}

// A note from the technician: observations, parts used, anything the office should know. It's
// saved under their name, so the job page and the dispatch drawer show it with the office's.
export async function addNote(user: SessionUser, jobId: string, body: string) {
  await findMyJob(user, jobId)
  const tenantId = tenantOf(user)
  const date = await db.transaction(async (tx) => {
    const job = await dispatchQueries.lockJob(tenantId, jobId, tx)
    // The office may have reassigned the job since the check above.
    if (!job || job.technicianId !== user.id) throw notYours()
    const note = await dispatchQueries.insertNote(tenantId, { jobId, authorId: user.id, body }, tx)
    await audit.insertUserAction(
      tenantId,
      {
        actorUserId: user.id,
        action: 'job.note_added',
        entityType: 'job',
        entityId: jobId,
        data: { noteId: note.id },
      },
      tx,
    )
    return job.date
  })
  // The dispatch drawer reloads on this event and shows the note.
  emitToTenant(tenantId, 'job.note_added', { jobId, dates: [date] })
  return getMyJob(user, jobId)
}

// The unit's brand and install year, set after diagnosing. It's saved on the address, so the
// office and the next visit see it too. Only while the visit is in progress.
export async function setEquipment(
  user: SessionUser,
  jobId: string,
  input: { equipmentBrand?: string | null; equipmentYear?: number | null },
) {
  await findMyJob(user, jobId)
  const tenantId = tenantOf(user)
  const equipment = {
    equipmentBrand: input.equipmentBrand ?? null,
    equipmentYear: input.equipmentYear ?? null,
  }
  await db.transaction(async (tx) => {
    const job = await dispatchQueries.lockJob(tenantId, jobId, tx)
    // The office may have reassigned the job since the check above.
    if (!job || job.technicianId !== user.id) throw notYours()
    if (job.status !== 'in_progress') {
      throw new HttpError(
        422,
        'invalid_transition',
        `This job is ${statusLabel(job.status)}, so the equipment can’t be changed.`,
      )
    }
    await queries.updateJobEquipment(tenantId, jobId, equipment, tx)
    await audit.insertUserAction(
      tenantId,
      {
        actorUserId: user.id,
        action: 'job.equipment_set',
        entityType: 'job',
        entityId: jobId,
        data: equipment,
      },
      tx,
    )
  })
  return getMyJob(user, jobId)
}
