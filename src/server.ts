import { createServer } from 'node:http'
import * as Sentry from '@sentry/node'
import { createApp } from './app.ts'
import { env } from './config/env.ts'
import { pool } from './db/client.ts'
import { startJobs, stopJobs } from './jobs/index.ts'
import { logger } from './lib/logger.ts'
import { attachRealtime } from './realtime/index.ts'

const server = createServer(createApp())
const io = attachRealtime(server)

try {
  await startJobs()
  server.listen(env.PORT, () => logger.info(`relay-api listening on http://localhost:${env.PORT}`))
} catch (error) {
  logger.fatal({ err: error }, 'Startup failed')
  Sentry.captureException(error)
  await Sentry.flush(2000)
  process.exit(1)
}

// Render sends SIGTERM before it replaces the instance: finish work in flight, then exit.
async function shutdown(signal: string) {
  logger.info({ signal }, 'Shutting down')
  await io.close() // also closes the HTTP server
  await stopJobs()
  await pool.end()
  process.exit(0)
}

process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)
