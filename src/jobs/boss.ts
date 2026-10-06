import * as Sentry from '@sentry/node'
import { PgBoss } from 'pg-boss'
import { env } from '../config/env.ts'
import { logger } from '../lib/logger.ts'

// The one pg-boss instance. Its own file so a module can queue a job without importing every
// job's handler (index.ts), which would import that module back.
export const boss = new PgBoss(env.DATABASE_URL)

boss.on('error', (error) => {
  logger.error({ err: error }, 'pg-boss error')
  Sentry.captureException(error)
})

// Runs a job soon, in the background, retried by pg-boss if it fails.
export async function queueJob(name: string, data: object) {
  await boss.send(name, data)
}
