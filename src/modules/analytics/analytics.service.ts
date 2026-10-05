import { nextDay } from '../../lib/local-day.ts'
import type { SessionUser } from '../accounts/accounts.service.ts'
import { tenantOf } from '../booking/booking.service.ts'
import { findTimezone } from '../dispatch/dispatch.queries.ts'
import * as queries from './analytics.queries.ts'
import type { RecoveryQuery } from './analytics.schemas.ts'

// The recovered-revenue dashboard's numbers for one range of local dates. See the spec
// for what each number counts.
export async function getRecovery(user: SessionUser, { from, to }: RecoveryQuery) {
  const tenantId = tenantOf(user)
  const timezone = await findTimezone(tenantId)
  const end = nextDay(to) // `to` is included
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
