import { z } from 'zod'
import { JobParams } from '../dispatch/dispatch.schemas.ts'

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

export const RepairInput = z.object({
  priceItemId: z.uuid('Pick a repair from the list'),
  quantity: z
    .number('Pick a quantity from 1 to 20')
    .int('Pick a quantity from 1 to 20')
    .min(1, 'Pick a quantity from 1 to 20')
    .max(20, 'Pick a quantity from 1 to 20'),
})

export const DecisionInput = z.object({
  decision: z.enum(['approved', 'declined'], 'Pick approve or decline'),
})

export const RepairParams = JobParams.extend({
  itemId: z.uuid('That repair isn’t on this job.'),
})
