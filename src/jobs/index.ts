import * as Sentry from '@sentry/node'
import { PgBoss } from 'pg-boss'
import { env } from '../config/env.ts'
import { logger } from '../lib/logger.ts'
import * as accounts from '../modules/accounts/accounts.service.ts'

const boss = new PgBoss(env.DATABASE_URL)

boss.on('error', (error) => {
  logger.error({ err: error }, 'pg-boss error')
  Sentry.captureException(error)
})

export async function startJobs() {
  await boss.start()

  await register('session-cleanup', { cron: '0 3 * * *' }, async () => {
    const deleted = await accounts.cleanupExpiredSessions()
    logger.info({ deleted }, 'Expired sessions deleted')
  })
}

export async function stopJobs() {
  await boss.stop({ graceful: true, timeout: 30_000 })
}

// A failed job goes to Sentry, then is rethrown so pg-boss retries it.
export function reportFailures<T>(name: string, handler: (data: T) => Promise<void>) {
  return async (jobs: { data: T }[]) => {
    for (const job of jobs) {
      try {
        await handler(job.data)
      } catch (error) {
        Sentry.captureException(error, { tags: { job: name } })
        throw error
      }
    }
  }
}

async function register<T = unknown>(
  name: string,
  options: { cron?: string },
  handler: (data: T) => Promise<void>,
) {
  await boss.createQueue(name)
  await boss.work<T>(name, reportFailures(name, handler))
  if (options.cron) await boss.schedule(name, options.cron, null, { tz: 'UTC' })
}
