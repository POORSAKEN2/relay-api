import request from 'supertest'
import { beforeEach, expect, it } from 'vitest'
import { resetDb } from '../../../test/helpers.ts'
import { createApp } from '../../app.ts'

// Own file: the limiter counts every sign-in attempt made by this test file.
const app = createApp()

beforeEach(resetDb)

it('counts email and phone sign-in attempts together and blocks an IP after 10 in 15 minutes', async () => {
  const phone = '(480) 555-0000'

  for (let i = 0; i < 4; i++) {
    await request(app)
      .post('/api/auth/sign-in')
      .send({ email: 'nobody@test.local', password: 'wrong', portal: 'contractor' })
      .expect(401)
  }
  for (let i = 0; i < 3; i++) {
    await request(app).post('/api/auth/phone/code').send({ phone }).expect(204)
  }
  for (let i = 0; i < 3; i++) {
    await request(app).post('/api/auth/phone/sign-in').send({ phone, code: '123456' }).expect(401)
  }

  const blocked = await request(app).post('/api/auth/phone/code').send({ phone }).expect(429)
  expect(blocked.body.error.code).toBe('rate_limited')
})
