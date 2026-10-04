import { db, type Tx } from '../../db/client.ts'
import type { jobs } from '../../db/schema.ts'
import { HttpError } from '../../lib/http-error.ts'
import { formatDay, formatTime, formatWindow, statusLabel, weekdayOf } from '../../lib/labels.ts'
import { emitToTenant } from '../../realtime/index.ts'
import type { SessionUser } from '../accounts/accounts.service.ts'
import * as audit from '../audit/audit.queries.ts'
import { reserveWindow, tenantOf } from '../booking/booking.service.ts'
import * as charges from '../charges/charges.service.ts'
import * as queries from './dispatch.queries.ts'
import type { SettableStatus, SlotInput } from './dispatch.schemas.ts'
import { textTechnician } from './technician-texts.ts'

type JobStatus = (typeof jobs.$inferSelect)['status']

// Which statuses the office can move a job to by hand. Anything not listed is refused.
const TRANSITIONS: Partial<Record<JobStatus, JobStatus[]>> = {
  booked: ['en_route', 'in_progress', 'no_access', 'cancelled'],
  en_route: ['in_progress', 'no_access', 'cancelled'],
  in_progress: ['done', 'cancelled'],
  no_access: ['booked', 'cancelled'],
}
const FINAL: JobStatus[] = ['done', 'cancelled', 'expired']
const NEEDS_TECHNICIAN: JobStatus[] = ['en_route', 'in_progress', 'done']
// A job can change day, window or technician only before the visit starts.
const MOVABLE: JobStatus[] = ['booked', 'no_access']

const JOB_NOT_FOUND = 'This job isn’t on the board anymore. It may have been cancelled.'

type LockedJob = NonNullable<Awaited<ReturnType<typeof queries.lockJob>>>

// "Arriving about 9:10 AM": only while the visit hasn't started, and only once the technician
// gave a time with "On my way" or "Running late".
export function arrivalLabel(status: JobStatus, etaLocal: string | null): string | null {
  return etaLocal && (status === 'booked' || status === 'en_route') ? formatTime(etaLocal) : null
}

export async function getBoard(tenantId: string, date: string) {
  const [timezone, windows, technicians, jobRows] = await Promise.all([
    queries.findTimezone(tenantId),
    queries.listWindowsOn(tenantId, weekdayOf(date)),
    queries.listActiveTechnicians(tenantId),
    queries.listJobsOn(tenantId, date),
  ])
  return {
    date,
    label: formatDay(date),
    timezone,
    windows: windows.map((window) => ({
      id: window.id,
      label: formatWindow(window.startsAt, window.endsAt),
      jobCap: window.jobCap,
      booked: jobRows.filter((job) => job.windowId === window.id).length,
    })),
    technicians,
    jobs: jobRows.map(({ localStart, localEnd, etaLocal, ...job }) => ({
      ...job,
      windowLabel: formatWindow(localStart, localEnd),
      etaLabel: arrivalLabel(job.status, etaLocal),
    })),
  }
}

// The technician's own photos as the job pages get them: before and after, oldest first.
// `basePath` is where the image route lives (the office's or the technician's); the web app
// puts the API's address in front of each `url`.
export function groupWorkPhotos(
  photos: { id: string; stage: 'before' | 'after' }[],
  basePath: string,
) {
  const stage = (wanted: 'before' | 'after') =>
    photos
      .filter((photo) => photo.stage === wanted)
      .map((photo) => ({ id: photo.id, url: `${basePath}/${photo.id}` }))
  return { before: stage('before'), after: stage('after') }
}

export async function getJob(tenantId: string, jobId: string) {
  const [job, notes, photos, workPhotos, jobCharges] = await Promise.all([
    queries.findJobDetail(tenantId, jobId),
    queries.listNotes(tenantId, jobId),
    queries.listJobPhotos(tenantId, jobId),
    queries.listWorkPhotos(tenantId, jobId),
    charges.getCharges(tenantId, jobId),
  ])
  if (!job) throw new HttpError(404, 'not_found', JOB_NOT_FOUND)
  const { localStart, localEnd, etaLocal, completedLocal, technicianId, technicianName, ...rest } =
    job
  return {
    job: {
      ...rest,
      dateLabel: formatDay(job.date),
      windowLabel: formatWindow(localStart, localEnd),
      etaLabel: arrivalLabel(job.status, etaLocal),
      completedLabel: completedLocal ? formatTime(completedLocal) : null,
      technician: technicianId ? { id: technicianId, name: technicianName } : null,
      allowedStatuses: TRANSITIONS[job.status] ?? [],
    },
    notes,
    // `url` is a path under the API; the web app puts the API's address in front.
    photos: photos.map((photo) => ({ id: photo.id, url: `/jobs/${jobId}/photos/${photo.id}` })),
    // What the technician took at the unit. The office only looks at these.
    workPhotos: groupWorkPhotos(workPhotos, `/jobs/${jobId}/work-photos`),
    charges: jobCharges,
  }
}

// A photo the homeowner added while booking this job.
export async function getJobPhoto(tenantId: string, jobId: string, photoId: string) {
  const photo = await queries.findJobPhoto(tenantId, jobId, photoId)
  if (!photo) throw new HttpError(404, 'not_found', 'That photo isn’t on this job.')
  return photo
}

// A photo the technician took on this visit.
export async function getWorkPhoto(tenantId: string, jobId: string, photoId: string) {
  const photo = await queries.findWorkPhoto(tenantId, jobId, photoId)
  if (!photo) throw new HttpError(404, 'not_found', 'That photo isn’t on this job.')
  return photo
}

// Assigns, reassigns or unassigns a technician and/or moves the job to another day or window.
export async function moveJob(user: SessionUser, jobId: string, input: SlotInput) {
  const tenantId = tenantOf(user)
  const result = await db.transaction(async (tx) => {
    const job = await queries.lockJob(tenantId, jobId, tx)
    if (!job) throw new HttpError(404, 'not_found', JOB_NOT_FOUND)
    if (!MOVABLE.includes(job.status)) {
      throw new HttpError(
        422,
        'job_locked',
        `This job is ${statusLabel(job.status)}, so it can’t be moved.`,
      )
    }
    if (
      input.technicianId &&
      !(await queries.findActiveTechnician(tenantId, input.technicianId, tx))
    ) {
      throw new HttpError(
        422,
        'technician_unavailable',
        'That technician isn’t available. Pick another one.',
      )
    }

    // Reassigning inside the same window must work even when that window is over its cap.
    const sameSlot = input.date === job.date && input.windowId === job.windowId
    const slot = sameSlot
      ? {}
      : await reserveWindow(tx, tenantId, input.windowId, input.date, {
          allowOverCap: input.allowOverCap,
          excludeJobId: job.id,
        })
    const reassigned = input.technicianId !== job.technicianId
    if (sameSlot && !reassigned) return { changed: false, dates: [job.date] }

    await queries.updateJob(
      tenantId,
      job.id,
      {
        technicianId: input.technicianId,
        ...slot,
        // A new time or technician makes the old arrival time meaningless.
        etaAt: null,
        // A no-access visit is booked again once it has a new time.
        ...(!sameSlot && job.status === 'no_access' ? { status: 'booked' as const } : {}),
      },
      tx,
    )
    if (reassigned) {
      await audit.insertUserAction(
        tenantId,
        {
          actorUserId: user.id,
          action: 'job.assigned',
          entityType: 'job',
          entityId: job.id,
          data: { from: job.technicianId, to: input.technicianId },
        },
        tx,
      )
    }
    if (!sameSlot) {
      await audit.insertUserAction(
        tenantId,
        {
          actorUserId: user.id,
          action: 'job.moved',
          entityType: 'job',
          entityId: job.id,
          data: {
            from: { date: job.date, windowId: job.windowId },
            to: { date: input.date, windowId: input.windowId },
            overCap: input.allowOverCap,
          },
        },
        tx,
      )
    }
    // The technician hears about it even with the app closed.
    if (input.technicianId) {
      await textTechnician(
        tenantId,
        job.id,
        input.technicianId,
        reassigned ? 'assigned' : 'changed',
        tx,
      )
    }
    return { changed: true, dates: [...new Set([job.date, input.date])] }
  })

  if (result.changed) emitToTenant(tenantId, 'job.assigned', { jobId, dates: result.dates })
  return { jobId, dates: result.dates }
}

// One status change, for the office's drawer and the technician's buttons alike: the only
// place the status rules are applied. `checkJob` runs on the locked job before the rules (the
// technician side checks the job is still theirs). `afterChange` runs in the same transaction,
// only when the status really changed (a homeowner text, a note).
export async function changeStatus(change: {
  tenantId: string
  // Who changed it: a signed-in user, or the homeowner from their manage link.
  actor: { userId: string } | 'homeowner'
  jobId: string
  to: JobStatus
  etaAt?: Date
  checkJob?: (job: LockedJob) => void
  afterChange?: (tx: Tx) => Promise<void>
}) {
  const { tenantId, jobId, to } = change
  const result = await db.transaction(async (tx) => {
    const job = await queries.lockJob(tenantId, jobId, tx)
    if (!job) throw new HttpError(404, 'not_found', JOB_NOT_FOUND)
    change.checkJob?.(job)
    // A double click, or someone else got there first: nothing to do.
    if (job.status === to) return { changed: false, date: job.date }

    const from = statusLabel(job.status)
    if (FINAL.includes(job.status)) {
      throw new HttpError(
        422,
        'invalid_transition',
        `This job is already ${from}, so its status can’t change.`,
      )
    }
    if (!(TRANSITIONS[job.status] ?? []).includes(to)) {
      const hint = to === 'done' ? ' Mark it in progress first.' : ''
      throw new HttpError(
        422,
        'invalid_transition',
        `This job is ${from}, so it can’t be marked ${statusLabel(to)}.${hint}`,
      )
    }
    if (NEEDS_TECHNICIAN.includes(to) && !job.technicianId) {
      throw new HttpError(
        422,
        'technician_required',
        `Assign a technician before marking this job ${statusLabel(to)}.`,
      )
    }

    const closing = to === 'done' || to === 'cancelled'
    await queries.updateJob(
      tenantId,
      job.id,
      {
        status: to,
        // An arrival time belongs to the step it was given for; any other change clears it.
        etaAt: change.etaAt ?? null,
        ...(to === 'done' ? { completedAt: new Date() } : {}),
        // Job links stop working once a job is closed.
        ...(closing ? { techLinkHash: null, manageLinkHash: null } : {}),
      },
      tx,
    )
    const event = {
      action: 'job.status_changed',
      entityType: 'job',
      entityId: job.id,
      data: { from: job.status, to },
    }
    if (change.actor === 'homeowner') await audit.insertHomeownerAction(tenantId, event, tx)
    else await audit.insertUserAction(tenantId, { ...event, actorUserId: change.actor.userId }, tx)
    await change.afterChange?.(tx)
    return { changed: true, date: job.date }
  })

  if (result.changed) {
    emitToTenant(tenantId, 'job.status_changed', { jobId, dates: [result.date] })
  }
  return result
}

// The office sets a job's status by hand from the drawer.
export async function setStatus(user: SessionUser, jobId: string, to: SettableStatus) {
  const { date } = await changeStatus({
    tenantId: tenantOf(user),
    actor: { userId: user.id },
    jobId,
    to,
  })
  return { jobId, dates: [date] }
}

export async function addNote(user: SessionUser, jobId: string, body: string) {
  const tenantId = tenantOf(user)
  if (!(await queries.jobExists(tenantId, jobId))) {
    throw new HttpError(404, 'not_found', JOB_NOT_FOUND)
  }
  const note = await queries.insertNote(tenantId, { jobId, authorId: user.id, body })
  await audit.insertUserAction(tenantId, {
    actorUserId: user.id,
    action: 'job.note_added',
    entityType: 'job',
    entityId: jobId,
    data: { noteId: note.id },
  })
  return { ...note, authorName: user.name }
}
