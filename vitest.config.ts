import { defineConfig } from 'vitest/config'

// Tests run against their own database (TEST_DATABASE_URL), never the development one.
try {
  process.loadEnvFile('.env')
} catch {
  // No .env file: TEST_DATABASE_URL has to come from the shell.
}

export default defineConfig({
  test: {
    env: {
      NODE_ENV: 'test',
      APP_DOMAIN: 'localhost',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? '',
      SIGN_IN_CODE_SECRET: 'test-only-sign-in-code-secret-0123456789',
      LOG_LEVEL: 'silent',
      SENTRY_DSN: '',
      SMS_PROVIDER: 'log', // tests never send a real text, whatever .env says
      EMAIL_PROVIDER: 'log', // tests never send a real email, whatever .env says
    },
    globalSetup: './test/global-setup.ts',
    fileParallelism: false, // test files share one database
  },
})
