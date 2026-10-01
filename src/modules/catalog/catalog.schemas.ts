import { z } from 'zod'
import { PRICE_TYPES } from '../../db/schema.ts'

const MAX_PRICE_CENTS = 10_000_000 // $100,000

// Adding or editing a service. The price rules match the checks on the `services` table:
// a free service costs nothing, every other one has a price above zero.
export const ServiceInput = z
  .object({
    name: z
      .string('Enter the service name')
      .trim()
      .min(1, 'Enter the service name')
      .max(100, 'Keep the name to 100 characters or fewer'),
    description: z.preprocess(
      (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
      z.string().trim().max(500, 'Keep the description to 500 characters or fewer').optional(),
    ),
    priceType: z.enum(PRICE_TYPES, 'Pick how this service is priced'),
    priceCents: z
      .number('Enter a price in dollars and cents')
      .int('Enter a price in dollars and cents'),
  })
  .superRefine(({ priceType, priceCents }, ctx) => {
    const message =
      priceType === 'free'
        ? priceCents !== 0 && 'A free service can’t have a price'
        : (priceCents <= 0 && 'Enter a price above $0') ||
          (priceCents > MAX_PRICE_CENTS && 'Enter a price of $100,000 or less')
    if (message) ctx.addIssue({ code: 'custom', path: ['priceCents'], message })
  })
export type ServiceInput = z.infer<typeof ServiceInput>

export const ServiceParams = z.object({
  serviceId: z.uuid('That service isn’t on your list.'),
})

// Every active service, in the order booking should show them.
export const ServiceOrderInput = z.object({
  ids: z.array(z.uuid()),
})

const PRICE_MESSAGE = 'Enter a price from $0 to $10,000'

// Adding or editing a repair price. $0 is allowed (a free check); $10,000 is the most.
export const PriceItemInput = z.object({
  name: z
    .string('Enter a name')
    .trim()
    .min(1, 'Enter a name')
    .max(100, 'Keep the name to 100 characters or fewer'),
  priceCents: z
    .number(PRICE_MESSAGE)
    .int(PRICE_MESSAGE)
    .min(0, PRICE_MESSAGE)
    .max(1_000_000, PRICE_MESSAGE),
})
export type PriceItemInput = z.infer<typeof PriceItemInput>

export const PriceItemParams = z.object({
  priceItemId: z.uuid('That price isn’t on your list.'),
})
