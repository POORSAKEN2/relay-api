import { pino } from 'pino'
import { env } from '../config/env.ts'

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: ['req.headers.cookie', 'res.headers["set-cookie"]'],
  transport: env.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
})
