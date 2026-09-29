import { z } from 'zod'
import { LocalDate } from '../../lib/fields.ts'

export const BoardQuery = z.object({ date: LocalDate })

export const JobParams = z.object({ jobId: z.uuid('This job link isn’t valid') })

// Where a job goes on the board: a day, a window, and a technician (null = unassigned).
export const SlotInput = z.object({
  date: LocalDate,
  windowId: z.uuid('Pick an arrival window'),
  technicianId: z.uuid('Pick a technician').nullable(),
  allowOverCap: z.boolean().default(false),
})
export type SlotInput = z.infer<typeof SlotInput>

// The statuses the office can set by hand. 'held' and 'expired' belong to online booking.
export const StatusInput = z.object({
  status: z.enum(
    ['booked', 'en_route', 'in_progress', 'no_access', 'done', 'cancelled'],
    'Pick a status',
  ),
})
export type SettableStatus = z.infer<typeof StatusInput>['status']

export const NoteInput = z.object({
  body: z
    .string()
    .trim()
    .min(1, 'Write a note first')
    .max(2000, 'Keep notes under 2,000 characters'),
})
