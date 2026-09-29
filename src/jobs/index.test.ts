import * as Sentry from '@sentry/node'
import { expect, it, vi } from 'vitest'
import { reportFailures } from './index.ts'

vi.mock('@sentry/node', () => ({ captureException: vi.fn() }))

it('sends a failed job to Sentry and rethrows so pg-boss retries it', async () => {
  const error = new Error('boom')
  const run = reportFailures('demo', async () => {
    throw error
  })

  await expect(run([{ data: {} }])).rejects.toBe(error)
  expect(Sentry.captureException).toHaveBeenCalledWith(error, { tags: { job: 'demo' } })
})
