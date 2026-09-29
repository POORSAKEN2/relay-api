import request from 'supertest'
import { beforeEach, expect, it } from 'vitest'
import { resetDb } from '../../../test/helpers.ts'
import { createApp } from '../../app.ts'

// Own file: the limiter counts every sign-in attempt made by this test file.
const app = createApp()

beforeEach(resetDb)

it('blocks an IP after 10 sign-in attempts in 15 minutes', async () => {
  const attempt = () =>
    request(app).post('/api/auth/sign-in').send({ email: 'nobody@test.local', password: 'wrong' })

  for (let i = 0; i < 10; i++) {
    await attempt().expect(401)
  }
  const blocked = await attempt().expect(429)
  expect(blocked.body.error.code).toBe('rate_limited')
})
