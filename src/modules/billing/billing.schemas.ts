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
