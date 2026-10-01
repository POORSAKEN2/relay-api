import { z } from 'zod'

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.url(),
  APP_DOMAIN: z.string().min(1),
  // Keys the hash of technician sign-in codes. Any random string of 32 or more characters.
  SIGN_IN_CODE_SECRET: z.string().min(32),
  SENTRY_DSN: z.url().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
})

export type Env = z.infer<typeof EnvSchema>

export function parseEnv(source: Record<string, string | undefined>): Env {
  // An empty value in .env (for example `SENTRY_DSN=`) counts as not set.
  const present = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ''))
  const result = EnvSchema.safeParse(present)
  if (!result.success) {
    throw new Error(`Invalid environment variables:\n${z.prettifyError(result.error)}`)
  }
  return result.data
}

export const env = parseEnv(process.env)
