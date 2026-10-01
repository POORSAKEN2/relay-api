import { z } from 'zod'

// How far away the technician is, in minutes. Running late adds a longer choice.
const ARRIVAL_MINUTES = [15, 30, 45, 60]
const LATE_MINUTES = [...ARRIVAL_MINUTES, 90]

export const OnMyWayInput = z.object({
  minutes: z.literal(ARRIVAL_MINUTES, 'Pick how far away you are'),
})

export const RunningLateInput = z.object({
  minutes: z.literal(LATE_MINUTES, 'Pick how far away you are'),
})

export const NoAccessInput = z.object({
  note: z.string().trim().max(1000, 'Keep the note under 1,000 characters').default(''),
})
