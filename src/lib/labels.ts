// Words and formats for messages people read. Dates are local calendar days ('2030-01-08'),
// times are the contractor's local wall-clock times ('08:00:00').

const WEEKDAYS_PLURAL = [
  'Sundays',
  'Mondays',
  'Tuesdays',
  'Wednesdays',
  'Thursdays',
  'Fridays',
  'Saturdays',
]

const dayFormat = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
})

// '08:00:00' → '8 AM', '12:30:00' → '12:30 PM'
export function formatTime(time: string): string {
  const [hours, minutes] = time.split(':').map(Number)
  const suffix = hours < 12 ? 'AM' : 'PM'
  const hour = hours % 12 || 12
  return minutes ? `${hour}:${String(minutes).padStart(2, '0')} ${suffix}` : `${hour} ${suffix}`
}

// A moment as the contractor's wall clock, '9:10 AM' or '12 PM', for times worked out in code
// (an arrival time) rather than read from the database already in local time.
export function formatClock(at: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at)
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '00'
  return formatTime(`${part('hour')}:${part('minute')}:00`)
}

// '8 AM–12 PM'
export function formatWindow(startsAt: string, endsAt: string): string {
  return `${formatTime(startsAt)}–${formatTime(endsAt)}`
}

// '8 AM - 12 PM', for a text. formatWindow's en dash would switch the whole text to Unicode,
// which halves how much fits in one SMS.
export function textWindow(startsAt: Date, endsAt: Date, timezone: string): string {
  return `${formatClock(startsAt, timezone)} - ${formatClock(endsAt, timezone)}`
}

// '2030-01-08' → 'Tue, Jan 8'
export function formatDay(date: string): string {
  return dayFormat.format(new Date(`${date}T00:00:00Z`))
}

const dateFormat = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
})

// '2030-01-08' → 'Jan 8, 2030'. For history, where the year matters.
export function formatDate(date: string): string {
  return dateFormat.format(new Date(`${date}T00:00:00Z`))
}

// 0 → 'Sundays'
export function weekdaysLabel(weekday: number): string {
  return WEEKDAYS_PLURAL[weekday]
}

// 0 = Sunday … 6 = Saturday, for a local calendar day.
export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay()
}

const STATUS_LABELS: Record<string, string> = {
  held: 'on hold',
  expired: 'expired',
  booked: 'booked',
  en_route: 'en route',
  in_progress: 'in progress',
  no_access: 'no access',
  done: 'done',
  cancelled: 'cancelled',
}

// 'en_route' → 'en route'
export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status
}

// '+639171234567' → '0917 123 4567', '+14805550100' → '(480) 555-0100'. Same as the web
// app's formatPhone. Any other number is shown as stored.
export function formatPhone(phone: string): string {
  const ph = /^\+63(9\d{2})(\d{3})(\d{4})$/.exec(phone)
  if (ph) return `0${ph[1]} ${ph[2]} ${ph[3]}`
  const us = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(phone)
  if (us) return `(${us[1]}) ${us[2]}-${us[3]}`
  return phone
}

// 4900, 'USD' → '$49.00'
export function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100)
}
