import { db, type Tx } from '../../db/client.ts'
import { emitToTenant } from '../../realtime/index.ts'
import type { SessionUser } from '../accounts/accounts.service.ts'
import * as audit from '../audit/audit.queries.ts'
import { tenantOf } from '../booking/booking.service.ts'
import * as queries from './schedule.queries.ts'
import type { Schedule } from './schedule.schemas.ts'

// Owner and office set when they're open and which arrival windows customers can book, with
// how many jobs each window takes. The screen edits one shared set for all ticked days.

// '08:00:00' → '08:00'
export function hhmm(time: string): string {
  return time.slice(0, 5)
}

// Days whose saved rows differ (only possible from old data) show the lowest day's values.
export async function getSchedule(tenantId: string): Promise<Schedule> {
  const [hours, windows] = await Promise.all([
    queries.listHours(tenantId),
    queries.listWindows(tenantId),
  ])
  const windowDays = [...new Set(windows.map((window) => window.weekday))]
  return {
    hours:
      hours.length === 0
        ? null
        : {
            days: hours.map((row) => row.weekday),
            opensAt: hhmm(hours[0].opensAt),
            closesAt: hhmm(hours[0].closesAt),
          },
    windows: windows
      .filter((window) => window.weekday === windowDays[0])
      .map((window) => ({
        startsAt: hhmm(window.startsAt),
        endsAt: hhmm(window.endsAt),
        jobCap: window.jobCap,
      })),
    windowDays,
  }
}

// Replaces the whole schedule. Jobs already booked keep their times.
export async function saveSchedule(user: SessionUser, schedule: Schedule) {
  const tenantId = tenantOf(user)
  const { hours } = schedule
  await db.transaction(async (tx) => {
    await queries.replaceHours(
      tenantId,
      hours
        ? hours.days.map((weekday) => ({
            weekday,
            opensAt: hours.opensAt,
            closesAt: hours.closesAt,
          }))
        : [],
      tx,
    )
    await syncWindows(tenantId, schedule, tx)
    await audit.insertUserAction(
      tenantId,
      {
        actorUserId: user.id,
        action: 'settings.schedule_updated',
        entityType: 'tenant',
        entityId: tenantId,
        data: {
          hoursDays: hours?.days ?? [],
          windowDays: schedule.windowDays,
          windows: schedule.windows.length,
        },
      },
      tx,
    )
  })
  emitToTenant(tenantId, 'schedule.updated', { tenantId })
  return getSchedule(tenantId)
}

// A saved window whose day and start time stay is updated in place, keeping its id: an open
// waitlist offer holds a window by id. The rest are deleted, then the new ones inserted, so
// the (tenant, weekday, starts_at) key never clashes mid-save.
async function syncWindows(tenantId: string, schedule: Schedule, tx: Tx) {
  const saved = await queries.listWindows(tenantId, tx)
  const kept = new Set<string>()
  const updates: { id: string; endsAt: string; jobCap: number }[] = []
  const inserts: { weekday: number; startsAt: string; endsAt: string; jobCap: number }[] = []
  for (const weekday of schedule.windowDays) {
    for (const window of schedule.windows) {
      const match = saved.find(
        (row) => row.weekday === weekday && hhmm(row.startsAt) === window.startsAt,
      )
      if (match) {
        kept.add(match.id)
        updates.push({ id: match.id, endsAt: window.endsAt, jobCap: window.jobCap })
      } else {
        inserts.push({ weekday, ...window })
      }
    }
  }
  await queries.deleteWindows(
    tenantId,
    saved.filter((row) => !kept.has(row.id)).map((row) => row.id),
    tx,
  )
  for (const { id, ...values } of updates) await queries.updateWindow(tenantId, id, values, tx)
  await queries.insertWindows(tenantId, inserts, tx)
}

// A place a job can hold: a weekday and a window's local start and end ('HH:MM').
type Place = { weekday: number; startsAt: string; endsAt: string }

function fits(job: Place, places: Place[]) {
  return places.some(
    (place) =>
      place.weekday === job.weekday &&
      place.startsAt === job.startsAt &&
      place.endsAt === job.endsAt,
  )
}

// Every weekday × window of a schedule.
export function placesOf(schedule: Pick<Schedule, 'windows' | 'windowDays'>): Place[] {
  return schedule.windowDays.flatMap((weekday) =>
    schedule.windows.map(({ startsAt, endsAt }) => ({ weekday, startsAt, endsAt })),
  )
}

// Jobs that sit in a window today and would sit in none after the change. A job already
// outside every window ("Other times") isn't counted, and neither is a lowered cap: the window
// just shows as full.
export function countAffected(jobs: Place[], before: Place[], after: Place[]): number {
  return jobs.filter((job) => fits(job, before) && !fits(job, after)).length
}

// How many upcoming jobs a change would touch, so the page can warn before saving.
export async function checkSchedule(tenantId: string, schedule: Schedule) {
  const [jobs, saved] = await Promise.all([
    queries.listUpcomingJobs(tenantId),
    queries.listWindows(tenantId),
  ])
  const before = saved.map((window) => ({
    weekday: window.weekday,
    startsAt: hhmm(window.startsAt),
    endsAt: hhmm(window.endsAt),
  }))
  return { affectedJobs: countAffected(jobs, before, placesOf(schedule)) }
}
