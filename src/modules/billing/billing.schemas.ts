import { z } from 'zod'

// What RevenueCat posts to /api/webhooks/revenuecat. Only the fields we use; the rest is ignored.
export const RevenueCatWebhook = z.object({
  event: z.object({
    id: z.string().min(1),
    type: z.string(),
    app_user_id: z.string().default(''), // our tenants.id: the web app signs in to RevenueCat with it
    environment: z.enum(['SANDBOX', 'PRODUCTION']),
    event_timestamp_ms: z.number(),
    expiration_at_ms: z.number().nullish(),
  }),
})
export type RevenueCatEvent = z.infer<typeof RevenueCatWebhook>['event']

// What a contractor pays Relay for each recovered job. 0 = no fee.
export const PerJobFeeInput = z.object({
  perJobFeeCents: z
    .number('Enter a fee in dollars and cents')
    .int('Enter a fee in dollars and cents')
    .min(0, 'Enter a fee of $0 or more')
    .max(1_000_000, 'Enter a fee of $10,000 or less'),
})

export const InvoiceParams = z.object({ invoiceId: z.uuid() })
