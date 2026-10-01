import { formatDay, formatWindow } from '../../lib/labels.ts'
import type { SessionUser } from '../accounts/accounts.service.ts'
import { tenantOf } from '../booking/booking.service.ts'
import * as queries from './technician-jobs.queries.ts'

// What a signed-in technician sees: only the jobs the office assigned to them. Read-only for
// now; status buttons, photos and payment come in later parts of module 8.

const DAYS_SHOWN = 7 // today and the next 6 days

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
