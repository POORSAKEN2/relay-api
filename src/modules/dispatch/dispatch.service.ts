import { db } from '../../db/client.ts'
import type { jobs } from '../../db/schema.ts'
import { HttpError } from '../../lib/http-error.ts'
import { formatDay, formatWindow, statusLabel, weekdayOf } from '../../lib/labels.ts'
import { emitToTenant } from '../../realtime/index.ts'
import type { SessionUser } from '../accounts/accounts.service.ts'
import * as audit from '../audit/audit.queries.ts'
import { reserveWindow, tenantOf } from '../booking/booking.service.ts'
import * as queries from './dispatch.queries.ts'
import type { SettableStatus, SlotInput } from './dispatch.schemas.ts'

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
    jobs: jobRows.map(({ localStart, localEnd, ...job }) => ({
      ...job,
      windowLabel: formatWindow(localStart, localEnd),
    })),
  }
}

export async function getJob(tenantId: string, jobId: string) {
  const [job, notes] = await Promise.all([
    queries.findJobDetail(tenantId, jobId),
    queries.listNotes(tenantId, jobId),
  ])
  if (!job) throw new HttpError(404, 'not_found', JOB_NOT_FOUND)
  const { localStart, localEnd, technicianId, technicianName, ...rest } = job
  return {
    job: {
      ...rest,
      dateLabel: formatDay(job.date),
      windowLabel: formatWindow(localStart, localEnd),
      technician: technicianId ? { id: technicianId, name: technicianName } : null,
      allowedStatuses: TRANSITIONS[job.status] ?? [],
    },
    notes,
  }
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
    return { changed: true, dates: [...new Set([job.date, input.date])] }
  })

  if (result.changed) emitToTenant(tenantId, 'job.assigned', { jobId, dates: result.dates })
  return { jobId, dates: result.dates }
}

// The office sets a job's status by hand (the technician job page will do it later).
export async function setStatus(user: SessionUser, jobId: string, to: SettableStatus) {
  const tenantId = tenantOf(user)
  const result = await db.transaction(async (tx) => {
    const job = await queries.lockJob(tenantId, jobId, tx)
    if (!job) throw new HttpError(404, 'not_found', JOB_NOT_FOUND)
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
        ...(to === 'done' ? { completedAt: new Date() } : {}),
        // Job links stop working once a job is closed.
        ...(closing ? { techLinkHash: null, manageLinkHash: null } : {}),
      },
      tx,
    )
    await audit.insertUserAction(
      tenantId,
      {
        actorUserId: user.id,
        action: 'job.status_changed',
        entityType: 'job',
        entityId: job.id,
        data: { from: job.status, to },
      },
      tx,
    )
    return { changed: true, date: job.date }
  })

  if (result.changed) {
    emitToTenant(tenantId, 'job.status_changed', { jobId, dates: [result.date] })
  }
  return { jobId, dates: [result.date] }
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
