import { randomUUID } from 'node:crypto'
import * as Sentry from '@sentry/node'
import cors from 'cors'
import express from 'express'
import { pinoHttp } from 'pino-http'
import { env } from './config/env.ts'
import { logger } from './lib/logger.ts'
import { checkOrigin } from './lib/origins.ts'
import { errorHandler } from './middleware/error-handler.ts'
import { accountsRoutes } from './modules/accounts/accounts.routes.ts'
import { bookingRoutes } from './modules/booking/booking.routes.ts'
import { brandingRoutes } from './modules/branding/branding.routes.ts'
import { catalogRoutes } from './modules/catalog/catalog.routes.ts'
import { customersRoutes } from './modules/customers/customers.routes.ts'
import { dispatchRoutes } from './modules/dispatch/dispatch.routes.ts'
import { onlineBookingRoutes } from './modules/online-booking/online-booking.routes.ts'
import { settingsRoutes } from './modules/settings/settings.routes.ts'
import { teamRoutes } from './modules/team/team.routes.ts'
import { technicianJobsRoutes } from './modules/technician-jobs/technician-jobs.routes.ts'
import { tenantsRoutes } from './modules/tenants/tenants.routes.ts'

export function createApp() {
  const app = express()
  app.disable('x-powered-by')
  if (env.NODE_ENV === 'production') app.set('trust proxy', 1) // Render's load balancer

  app.use(
    pinoHttp({
      logger,
      genReqId: (_req, res) => {
        const id = randomUUID()
        res.setHeader('X-Request-Id', id)
        Sentry.setTag('request_id', id)
        return id
      },
    }),
  )
  app.use(cors({ origin: checkOrigin, credentials: true, maxAge: 600 }))
  app.use(express.json())

  app.get('/health', (_req, res) => {
    res.json({ ok: true })
  })
  app.use(
    '/api',
    accountsRoutes,
    brandingRoutes,
    bookingRoutes,
    catalogRoutes,
    customersRoutes,
    dispatchRoutes,
    onlineBookingRoutes,
    settingsRoutes,
    teamRoutes,
    technicianJobsRoutes,
    tenantsRoutes,
  )

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'Route not found' } })
  })
  app.use(errorHandler)

  return app
}
