import * as Sentry from '@sentry/node'
import { ZodError } from 'zod'
import { env } from './config/env.ts'

// Loaded with `node --import` so Sentry is ready before Express and pg are imported.
// Without SENTRY_DSN (local development, tests) nothing is sent.
Sentry.init({
  dsn: env.SENTRY_DSN,
  environment: env.NODE_ENV,
  // Leave out incomingRequest: codes and passwords in sign-in bodies must not leave the server.
  // The SDK has no per-route switch, so no request body is attached to any event.
  dataCollection: { httpBodies: ['outgoingRequest', 'incomingResponse', 'outgoingResponse'] },
  integrations: [
    Sentry.expressIntegration({
      // Only 5xx are bugs. Validation errors and other 4xx are the caller's mistake.
      shouldHandleError: (error) =>
        !(error instanceof ZodError) && Number(error.status ?? 500) >= 500,
    }),
  ],
})
