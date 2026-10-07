import * as Sentry from '@sentry/node'
import { logger } from '../lib/logger.ts'
import * as accounts from '../modules/accounts/accounts.service.ts'
import * as billing from '../modules/billing/billing.service.ts'
import * as homeownerMessages from '../modules/homeowner-messages/homeowner-messages.service.ts'
import * as onlineBooking from '../modules/online-booking/online-booking.service.ts'
import * as waitlist from '../modules/online-booking/waitlist.service.ts'
import { wrapUpCall } from '../modules/receptionist/wrap-up.ts'
import { boss } from './boss.ts'

export async function startJobs() {
  await boss.start()

  await register('session-cleanup', { cron: '0 3 * * *' }, async () => {
    const deleted = await accounts.cleanupExpiredSessions()
    logger.info({ deleted }, 'Expired sessions deleted')
  })

  // Every minute: online-booking holds nobody paid for in time free their arrival window.
  await register('hold-expiry', { cron: '* * * * *' }, async () => {
    const expired = await onlineBooking.expireHolds()
    if (expired > 0) logger.info({ expired }, 'Booking holds expired')
  })

  // Every 5 minutes: homeowners who stopped partway through booking get one text to finish.
  await register('booking-recovery', { cron: '*/5 * * * *' }, async () => {
    const texted = await onlineBooking.sendRecoveryTexts()
    if (texted > 0) logger.info({ texted }, 'Booking recovery texts saved')
  })

  // Every minute: a place that opened goes to the next homeowner on the waitlist.
  await register('waitlist-offers', { cron: '* * * * *' }, async () => {
    const { offered, expired } = await waitlist.sendWaitlistOffers()
    if (offered > 0 || expired > 0) logger.info({ offered, expired }, 'Waitlist offers made')
  })

  // Every 5 minutes: homeowners are reminded of their visit a day and two hours before it.
  await register('visit-reminders', { cron: '*/5 * * * *' }, async () => {
    const reminded = await homeownerMessages.sendVisitReminders()
    if (reminded > 0) logger.info({ reminded }, 'Visit reminders saved')
  })

  // Daily: once a contractor's month has ended in its time zone, invoice its recovered jobs.
  // 12:00 UTC is past midnight on the 1st everywhere in the US.
  await register('recovered-job-invoices', { cron: '0 12 * * *' }, async () => {
    const created = await billing.createMonthlyInvoices()
    if (created > 0) logger.info({ created }, 'Recovered-job invoices made')
  })

  // Daily: photos on bookings nobody finished go 30 days after the homeowner's last activity.
  await register('booking-photo-cleanup', { cron: '30 3 * * *' }, async () => {
    const deleted = await onlineBooking.deleteIdlePhotos()
    if (deleted > 0) logger.info({ deleted }, 'Idle booking photos deleted')
  })

  // Queued when an AI call ends: its summary, on the call and on the job it booked.
  await register<{ tenantId: string; callId: string }>('call-wrapup', {}, ({ tenantId, callId }) =>
    wrapUpCall(tenantId, callId),
  )
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
