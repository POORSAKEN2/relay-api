import { z } from 'zod'
import { LocalDate } from '../../lib/fields.ts'

// A range of the contractor's local dates, both days included.
export const RecoveryQuery = z
  .object({ from: LocalDate, to: LocalDate })
  .refine(({ from, to }) => from <= to, {
    message: 'The end date must be on or after the start date',
    path: ['to'],
  })
export type RecoveryQuery = z.infer<typeof RecoveryQuery>

// How many weeks of the chart, the current week last.
export const WeeklyQuery = z.object({
  weeks: z.coerce.number().int().min(1).max(26).default(12),
})
export type WeeklyQuery = z.infer<typeof WeeklyQuery>
