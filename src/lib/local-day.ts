import { sql } from 'drizzle-orm'

// The instant a contractor's local day starts, worked out by Postgres:
// '2026-09-01' in America/Phoenix is 2026-09-01 07:00 UTC.
export function startOfLocalDay(day: string, timezone: string) {
  return sql`${day}::date::timestamp at time zone ${timezone}`
}

// '2026-10-31' → '2026-11-01'. Turns an inclusive last day into an exclusive end.
export function nextDay(day: string) {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + 1)
  return date.toISOString().slice(0, 10)
}
