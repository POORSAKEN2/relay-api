import { formatDay, formatTime } from '../../lib/labels.ts'
import { lastMorning, quietUntil } from '../messaging/rules.ts'
import * as queries from './online-booking.queries.ts'

// What the next-morning lead-recovery texts share: a homeowner who stopped partway through
// booking, and a caller nobody answered, each get one text on the first morning after.
// "Morning" is when the contractor's quiet hours end. The texts are written then, during the
// contractor's day, so the open times they list are still open.

const WAIT_MINUTES = 60 // a lead quiet less than this isn't texted yet, even past the morning
const DAYS_AHEAD = 14 // the booking calendar's two weeks
const OPEN_TIMES = 3

export type DueTenant = Awaited<ReturnType<typeof queries.listRecoveryTenants>>[number] & {
  since: Date
  before: Date
}

// Contractors whose morning has begun and who aren't in quiet hours, each with the range of
// leads due today: from the previous morning up to this morning (and at least WAIT_MINUTES
// ago). Each lead falls in one day's range only, so a job that was down all day skips it
// rather than texting it a day late.
export async function listDueTenants(now = new Date()): Promise<DueTenant[]> {
  const due: DueTenant[] = []
  for (const tenant of await queries.listRecoveryTenants()) {
    if (quietUntil(now, tenant.timezone, tenant.quietHoursStart, tenant.quietHoursEnd)) continue
    const morning = lastMorning(now, tenant.timezone, tenant.quietHoursEnd)
    due.push({
      ...tenant,
      since: new Date(morning.getTime() - 24 * 3_600_000),
      before: new Date(Math.min(morning.getTime(), now.getTime() - WAIT_MINUTES * 60_000)),
    })
  }
  return due
}

// The first open arrival windows, as a text lists them: 'Tue, Oct 13 8 AM - 12 PM'. A plain
// hyphen, not formatWindow's en dash, which would switch the text to Unicode.
export async function nextOpenWindows(tenantId: string) {
  const rows = await queries.listOpenWindows(tenantId, DAYS_AHEAD)
  return rows
    .slice(0, OPEN_TIMES)
    .map((row) => `${formatDay(row.date)} ${formatTime(row.startsAt)} - ${formatTime(row.endsAt)}`)
}
