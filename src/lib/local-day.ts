import { sql } from 'drizzle-orm'

// The instant a contractor's local day starts, worked out by Postgres:
// '2026-09-01' in America/Phoenix is 2026-09-01 07:00 UTC.
export function startOfLocalDay(day: string, timezone: string) {
  return sql`${day}::date::timestamp at time zone ${timezone}`
}

// The local date right now in a time zone, as '2026-10-06'.
export function localToday(timezone: string, now = new Date()) {
  // en-CA writes dates as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(now)
}

// '2026-10-31' + 1 → '2026-11-01'; a negative n goes back. `addDays(last, 1)` turns an
// inclusive last day into an exclusive end.
export function addDays(day: string, n: number) {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + n)
  return date.toISOString().slice(0, 10)
}

// The Monday of the week a day is in (weeks start on Monday, like Postgres' date_trunc).
export function mondayOf(day: string) {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay() // 0 = Sunday
  return addDays(day, -((weekday + 6) % 7))
}
