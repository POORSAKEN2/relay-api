import { HttpError } from '../../lib/http-error.ts'
import { formatDay, formatWindow } from '../../lib/labels.ts'
import type { SessionUser } from '../accounts/accounts.service.ts'
import { tenantOf } from '../booking/booking.service.ts'
import * as dispatch from '../dispatch/dispatch.queries.ts'
import * as queries from './technician-jobs.queries.ts'

// What a signed-in technician sees: only the jobs the office assigned to them. Read-only for
// now; status buttons, photos and payment come in later parts of module 8.

const DAYS_SHOWN = 7 // today and the next 6 days
const NOT_YOURS = 'This job isn’t assigned to you anymore.'

// The technician's jobs, grouped by local day. Days without jobs are left out.
export async function listMyJobs(user: SessionUser) {
  const rows = await queries.listTechnicianJobs(tenantOf(user), user.id, DAYS_SHOWN)
  const days: {
    date: string
    label: string
    jobs: {
      id: string
      status: (typeof rows)[number]['status']
      priority: boolean
      windowLabel: string
      customerName: string
      street: string
      city: string
      serviceName: string
    }[]
  }[] = []
  for (const { date, localStart, localEnd, ...job } of rows) {
    // Rows come sorted by day, so a new date always starts a new group.
    if (days.at(-1)?.date !== date) days.push({ date, label: formatDay(date), jobs: [] })
    days.at(-1)!.jobs.push({ ...job, windowLabel: formatWindow(localStart, localEnd) })
  }
  return { days }
}

// The job, if it's this technician's and still shows on their list. Anything else (another
// technician's, unassigned, another contractor's, cancelled) gets the same 404, so the answer
// doesn't reveal which jobs exist.
async function findMyJob(user: SessionUser, jobId: string) {
  const job = await dispatch.findJobDetail(tenantOf(user), jobId)
  const visible = (queries.VISIBLE_STATUSES as readonly string[]).includes(job?.status ?? '')
  if (!job || job.technicianId !== user.id || !visible) {
    throw new HttpError(404, 'not_found', NOT_YOURS)
  }
  return job
}

// Everything the technician needs for the visit. Office-only parts (the schedule, allowed
// status changes, the customer's email, where the booking came from) are left out.
export async function getMyJob(user: SessionUser, jobId: string) {
  const job = await findMyJob(user, jobId)
  const tenantId = tenantOf(user)
  const [notes, photos] = await Promise.all([
    dispatch.listNotes(tenantId, jobId),
    dispatch.listJobPhotos(tenantId, jobId),
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
  const photo = await dispatch.findJobPhoto(tenantOf(user), jobId, photoId)
  if (!photo) throw new HttpError(404, 'not_found', 'That photo isn’t on this job.')
  return photo
}
