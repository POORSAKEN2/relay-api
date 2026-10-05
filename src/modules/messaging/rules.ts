import type { MESSAGE_KINDS } from '../../db/schema.ts'

export type MessageKind = (typeof MESSAGE_KINDS)[number]

// How the compliance rules treat one kind of text.
// consent: 'required' = the homeowner must have agreed to texts; 'opt_out' = allowed unless
// they texted STOP; 'none' = not checked (the contractor's own staff).
// quietHours: true = held until quiet hours end.
export type TextRule = { consent: 'required' | 'opt_out' | 'none'; quietHours: boolean }

// To the contractor's own people: they need their sign-in codes and alerts at any hour.
const STAFF: TextRule = { consent: 'none', quietHours: false }
// Routine office news: no need to wake anyone.
const STAFF_ROUTINE: TextRule = { consent: 'none', quietHours: true }
// Answers something the homeowner just did (called, texted in). They never filled in the
// booking form, so there is no consent to find; a STOP still blocks.
const REPLY: TextRule = { consent: 'opt_out', quietHours: false }
// Texts the homeowner didn't just ask for: never at night.
const UNPROMPTED: TextRule = { consent: 'required', quietHours: true }
// About a visit happening now or just booked: sent at once.
const VISIT: TextRule = { consent: 'required', quietHours: false }

// Every kind has a rule: TypeScript refuses a new kind in MESSAGE_KINDS until it is placed here.
export const TEXT_RULES: Record<MessageKind, TextRule> = {
  inbound: STAFF, // never sent; here only so every kind has a rule
  sign_in_code: STAFF,
  job_assigned: STAFF,
  new_booking_alert: STAFF_ROUTINE,
  priority_alert: STAFF,
  text_back: REPLY,
  manual: REPLY,
  abandoned_booking: UNPROMPTED,
  missed_caller_reminder: UNPROMPTED,
  waitlist_offer: UNPROMPTED,
  reminder: UNPROMPTED,
  payment_reminder: UNPROMPTED,
  review_request: UNPROMPTED,
  booking_confirmation: VISIT,
  booking_changed: VISIT,
  on_my_way: VISIT,
  running_late: VISIT,
  job_started: VISIT,
  no_access: VISIT,
  invoice: VISIT,
  card_link: VISIT,
}

// Kinds that go to homeowners: the ones whose rule checks consent. A STOP blocks these,
// including any already waiting to go out (webhooks.service.ts).
export const HOMEOWNER_KINDS = (Object.keys(TEXT_RULES) as MessageKind[]).filter(
  (kind) => TEXT_RULES[kind].consent !== 'none',
)

const DAY_SECONDS = 24 * 60 * 60

// When quiet hours end, if `now` falls inside them in the contractor's timezone; else null.
// `start` and `end` are wall-clock times ('21:00:00'); the window may cross midnight.
// Daylight-saving days are off by up to an hour, which is fine for "not at night".
export function quietUntil(now: Date, timezone: string, start: string, end: string): Date | null {
  const local = secondsOfDay(now, timezone)
  const from = secondsOfDay(start)
  const to = secondsOfDay(end)
  const inside = from < to ? local >= from && local < to : local >= from || local < to
  if (!inside) return null
  const wait = (to - local + DAY_SECONDS) % DAY_SECONDS
  return new Date(now.getTime() + wait * 1000)
}

// Seconds since local midnight, of a moment in a timezone or of a '21:00:00' time.
function secondsOfDay(moment: Date | string, timezone?: string): number {
  const clock =
    typeof moment === 'string'
      ? moment
      : new Intl.DateTimeFormat('en-GB', {
          timeZone: timezone,
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hourCycle: 'h23',
        }).format(moment)
  const [hours, minutes, seconds = 0] = clock.split(':').map(Number)
  return hours * 3600 + minutes * 60 + seconds
}
