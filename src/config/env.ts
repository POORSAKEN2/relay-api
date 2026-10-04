import { z } from 'zod'

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    DATABASE_URL: z.url(),
    APP_DOMAIN: z.string().min(1),
    // Keys the hash of technician sign-in codes. Any random string of 32 or more characters.
    SIGN_IN_CODE_SECRET: z.string().min(32),
    SENTRY_DSN: z.url().optional(),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    // 'log' sends nothing: texts are logged (printed in development). 'httpsms' really sends.
    SMS_PROVIDER: z.enum(['log', 'httpsms']).default('log'),
    HTTPSMS_API_KEY: z.string().min(1).optional(),
    // The signing key typed when the webhook was created in httpSMS.
    HTTPSMS_WEBHOOK_SIGNING_KEY: z.string().min(1).optional(),
    // db:seed only: the demo phone's number, E.164 ('+639171234567').
    SEED_SMS_NUMBER: z
      .string()
      .regex(/^\+[1-9]\d{7,14}$/)
      .optional(),
    // 'log' sends nothing: emails are logged (printed in development). 'smtp' really sends,
    // through Gmail for the demo (docs/gmail-setup.md).
    EMAIL_PROVIDER: z.enum(['log', 'smtp']).default('log'),
    SMTP_HOST: z.string().min(1).default('smtp.gmail.com'),
    SMTP_PORT: z.coerce.number().int().positive().default(465),
    SMTP_USER: z.email().optional(), // the Gmail address emails are sent from
    // A Gmail app password. Google shows it in groups of four with spaces; they don't count.
    SMTP_PASS: z
      .string()
      .transform((value) => value.replace(/\s/g, ''))
      .pipe(z.string().min(1))
      .optional(),
  })
  .superRefine((env, ctx) => {
    const needs = (names: (keyof typeof env)[], why: string) => {
      for (const name of names) {
        if (!env[name]) ctx.addIssue({ code: 'custom', path: [name], message: why })
      }
    }
    if (env.SMS_PROVIDER === 'httpsms') {
      needs(
        ['HTTPSMS_API_KEY', 'HTTPSMS_WEBHOOK_SIGNING_KEY'],
        'Required with SMS_PROVIDER=httpsms',
      )
    }
    if (env.EMAIL_PROVIDER === 'smtp') {
      needs(['SMTP_USER', 'SMTP_PASS'], 'Required with EMAIL_PROVIDER=smtp')
    }
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
