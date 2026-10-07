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
    // 'log' sends nothing: emails are logged (printed in development). 'smtp' really sends.
    EMAIL_PROVIDER: z.enum(['log', 'smtp']).default('log'),
    SMTP_HOST: z.string().min(1).default('smtp.gmail.com'),
    SMTP_PORT: z.coerce.number().int().positive().default(465),
    // For Gmail: the address, and a 16-character app password (not the account password).
    // Google shows the password in groups of four with spaces; they don't count.
    SMTP_USER: z.string().min(1).optional(),
    SMTP_PASSWORD: z
      .string()
      .transform((value) => value.replace(/\s/g, ''))
      .pipe(z.string().min(1))
      .optional(),
    // The From header, for example 'Relay <you@gmail.com>'. Gmail rewrites it to SMTP_USER.
    EMAIL_FROM: z.string().min(1).optional(),
    // Phone calls (Telnyx). The API key sends call commands; the public key (base64, from the
    // Telnyx portal) checks that webhooks really come from Telnyx.
    TELNYX_API_KEY: z.string().min(1).optional(),
    TELNYX_PUBLIC_KEY: z.string().min(1).optional(),
    // The language model behind the AI receptionist. 'off' answers nothing: every call takes
    // a message instead. 'groq' and 'anthropic' need their key.
    LLM_PROVIDER: z.enum(['off', 'groq', 'anthropic']).default('off'),
    GROQ_API_KEY: z.string().min(1).optional(),
    GROQ_MODEL: z.string().min(1).default('openai/gpt-oss-20b'),
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    ANTHROPIC_MODEL: z.string().min(1).default('claude-haiku-4-5'),
    // A caller hears silence while the model thinks: give up after this long.
    LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
    // 'true' opens the receptionist test console: a pretend call from the browser. Its
    // bookings are real jobs, so it stays off in production except for a demo.
    RECEPTIONIST_TEST_CONSOLE: z.stringbool().default(false),
    // The Authorization header value typed when the webhook was created in RevenueCat.
    REVENUECAT_WEBHOOK_AUTH: z.string().min(16).optional(),
    // db:seed only: the demo phone's number, E.164 ('+639171234567').
    SEED_SMS_NUMBER: z
      .string()
      .regex(/^\+[1-9]\d{7,14}$/)
      .optional(),
  })
  .superRefine((env, ctx) => {
    if (env.SMS_PROVIDER === 'httpsms') {
      for (const name of ['HTTPSMS_API_KEY', 'HTTPSMS_WEBHOOK_SIGNING_KEY'] as const) {
        if (!env[name])
          ctx.addIssue({
            code: 'custom',
            path: [name],
            message: 'Required with SMS_PROVIDER=httpsms',
          })
      }
    }
    if (env.LLM_PROVIDER === 'groq' && !env.GROQ_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['GROQ_API_KEY'],
        message: 'Required with LLM_PROVIDER=groq',
      })
    }
    if (env.LLM_PROVIDER === 'anthropic' && !env.ANTHROPIC_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['ANTHROPIC_API_KEY'],
        message: 'Required with LLM_PROVIDER=anthropic',
      })
    }
    if (env.EMAIL_PROVIDER === 'smtp') {
      for (const name of ['SMTP_USER', 'SMTP_PASSWORD', 'EMAIL_FROM'] as const) {
        if (!env[name])
          ctx.addIssue({
            code: 'custom',
            path: [name],
            message: 'Required with EMAIL_PROVIDER=smtp',
          })
      }
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
