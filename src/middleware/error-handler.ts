import type { ErrorRequestHandler } from 'express'
import { ZodError } from 'zod'
import { HttpError } from '../lib/http-error.ts'
import { logger } from '../lib/logger.ts'

// Every error response has the shape { error: { code, message, details?, requestId? } }.
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  // An error is only true right now. Browsers may keep some (404, 410) on their own, and a
  // contractor suspended for a minute would then look closed long after coming back.
  res.set('Cache-Control', 'no-store')
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'validation_failed',
        message: 'Check the highlighted fields.',
        details: fieldErrors(err),
      },
    })
    return
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } })
    return
  }
  // Express's own 4xx errors, such as malformed JSON or a body that is too large.
  if (err.status >= 400 && err.status < 500) {
    res.status(err.status).json({ error: { code: 'bad_request', message: err.message } })
    return
  }
  logger.error({ err, requestId: req.id }, 'Unhandled error')
  res.status(500).json({
    error: {
      code: 'internal',
      message: 'Something went wrong on our side. Try again.',
      requestId: req.id,
    },
  })
}

// { "address.zip": ["Invalid ZIP code"] }
function fieldErrors(error: ZodError): Record<string, string[]> {
  const details: Record<string, string[]> = {}
  for (const issue of error.issues) {
    const path = issue.path.map(String).join('.') || '(root)'
    details[path] = [...(details[path] ?? []), issue.message]
  }
  return details
}
