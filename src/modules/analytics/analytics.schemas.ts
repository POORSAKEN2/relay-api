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
