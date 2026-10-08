import { z } from 'zod'
import { formatWindow } from '../../lib/labels.ts'

const MAX_WINDOWS = 8
const CAP_MESSAGE = 'Enter a cap from 1 to 20 jobs'

// The contractor's local time, on the hour or half hour: '08:00', '13:30'.
const Time = z
  .string('Pick a time on the hour or half hour')
  .regex(/^([01]\d|2[0-3]):(00|30)$/, 'Pick a time on the hour or half hour')

// Days of the week, 0 = Sunday … 6 = Saturday. A day listed twice counts once.
const Days = (emptyMessage: string) =>
  z
    .array(z.number().int().min(0, 'Pick a day of the week').max(6, 'Pick a day of the week'))
    .min(1, emptyMessage)
    .transform((days) => [...new Set(days)].sort((a, b) => a - b))

const Hours = z
  .object({ days: Days('Tick at least one day'), opensAt: Time, closesAt: Time })
  .refine((hours) => hours.closesAt > hours.opensAt, {
    message: 'Close after you open',
    path: ['closesAt'],
  })

const Window = z
  .object({
    startsAt: Time,
    endsAt: Time,
    jobCap: z.number(CAP_MESSAGE).int(CAP_MESSAGE).min(1, CAP_MESSAGE).max(20, CAP_MESSAGE),
  })
  .refine((window) => window.endsAt > window.startsAt, {
    message: 'End after the start',
    path: ['endsAt'],
  })

// The whole schedule: one set of hours and one set of windows, each with the days it applies
// to. `hours: null` means closed every day. Windows come back sorted by start.
export const ScheduleInput = z
  .object({
    hours: Hours.nullable(),
    windows: z
      .array(Window)
      .min(1, 'Add at least one arrival window')
      .max(MAX_WINDOWS, 'Keep it to 8 windows or fewer'),
    windowDays: Days('Tick at least one day for the windows'),
  })
  .superRefine((schedule, ctx) => {
    const sorted = schedule.windows
      .map((window, index) => ({ ...window, index }))
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.index - b.index)
    for (let i = 1; i < sorted.length; i++) {
      const previous = sorted[i - 1]
      const current = sorted[i]
      if (current.startsAt < previous.endsAt) {
        ctx.addIssue({
          code: 'custom',
          path: ['windows', current.index, 'startsAt'],
          message: `Windows can’t overlap: ${formatWindow(previous.startsAt, previous.endsAt)} and ${formatWindow(current.startsAt, current.endsAt)}`,
        })
      }
    }
  })
  .transform((schedule) => ({
    ...schedule,
    windows: [...schedule.windows].sort((a, b) => a.startsAt.localeCompare(b.startsAt)),
  }))

export type Schedule = z.infer<typeof ScheduleInput>
