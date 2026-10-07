import { addDays, localToday, mondayOf } from '../../lib/local-day.ts'
import type { SessionUser } from '../accounts/accounts.service.ts'
import { tenantOf } from '../booking/booking.service.ts'
import { findTimezone } from '../dispatch/dispatch.queries.ts'
import * as queries from './analytics.queries.ts'
import type { RecoveryQuery, WeeklyQuery } from './analytics.schemas.ts'

// The recovered-revenue dashboard's numbers for one range of local dates. See the spec
// for what each number counts.
export async function getRecovery(user: SessionUser, { from, to }: RecoveryQuery) {
  const tenantId = tenantOf(user)
  const timezone = await findTimezone(tenantId)
  const end = addDays(to, 1) // `to` is included

  const [calls, recovered] = await Promise.all([
    queries.countCalls(tenantId, timezone, from, end),
    queries.sumRecoveredJobs(tenantId, timezone, from, end),
  ])

  return {
    from,
    to,
    missedCalls: calls.missed,
    handledByTextBack: calls.textBack,
    handledByAi: calls.ai,
    jobsBooked: recovered.jobs,
    revenueCents: recovered.revenueCents,
  }
}

// Recovered jobs and revenue for each of the last `weeks` weeks (Monday to Sunday, the
// contractor's time zone), oldest first and ending with this week. Empty weeks are zeros, so
// the chart always has every bar.
export async function getWeekly(user: SessionUser, { weeks }: WeeklyQuery) {
  const tenantId = tenantOf(user)
  const timezone = await findTimezone(tenantId)
  const thisMonday = mondayOf(localToday(timezone))
  const firstMonday = addDays(thisMonday, -7 * (weeks - 1))

  const rows = await queries.sumRecoveredJobsByWeek(
    tenantId,
    timezone,
    firstMonday,
    addDays(thisMonday, 7),
  )

  const result = []
  for (let i = 0; i < weeks; i++) {
    const weekStart = addDays(firstMonday, 7 * i)
    const row = rows.find((candidate) => candidate.weekStart === weekStart)
    result.push({ weekStart, jobsBooked: row?.jobs ?? 0, revenueCents: row?.revenueCents ?? 0 })
  }
  return { weeks: result }
}
