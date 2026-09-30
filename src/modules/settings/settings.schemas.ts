import { z } from 'zod'
import { Zip } from '../../lib/fields.ts'

const MAX_FEE_CENTS = 10_000_000 // $100,000
const MAX_ZIPS = 1000

// 0 turns priority service off on the booking page.
export const PriorityFeeInput = z.object({
  priorityFeeCents: z
    .number('Enter a fee in dollars and cents')
    .int('Enter a fee in dollars and cents')
    .min(0, 'Enter a fee of $0 or more')
    .max(MAX_FEE_CENTS, 'Enter a fee of $100,000 or less'),
})

// The whole service area: every ZIP code the contractor serves.
export const ServiceAreaInput = z.object({
  zips: z.array(Zip).max(MAX_ZIPS, 'Keep the list to 1,000 ZIP codes or fewer'),
})
