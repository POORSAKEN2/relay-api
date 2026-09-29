import express from 'express'
import request from 'supertest'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { HttpError } from '../lib/http-error.ts'
import { errorHandler } from './error-handler.ts'

const app = express()
app.use(express.json())
app.post('/validate', (req) => {
  z.object({ address: z.object({ zip: z.string().length(5) }) }).parse(req.body)
})
app.get('/not-found', () => {
  throw new HttpError(404, 'not_found', 'Contractor not found')
})
app.get('/crash', () => {
  throw new Error('database password is hunter2')
})
app.use(errorHandler)

it('turns a ZodError into 400 with dotted field paths', async () => {
  const res = await request(app)
    .post('/validate')
    .send({ address: { zip: '1' } })
    .expect(400)
  expect(res.body).toEqual({
    error: {
      code: 'validation_failed',
      message: 'Check the highlighted fields.',
      details: { 'address.zip': [expect.any(String)] },
    },
  })
})

it('uses the status and code of an HttpError', async () => {
  const res = await request(app).get('/not-found').expect(404)
  expect(res.body).toEqual({ error: { code: 'not_found', message: 'Contractor not found' } })
})

it('answers malformed JSON with 400', async () => {
  const res = await request(app)
    .post('/validate')
    .set('Content-Type', 'application/json')
    .send('{"address":')
    .expect(400)
  expect(res.body.error.code).toBe('bad_request')
})

it('hides the details of an unexpected error behind a 500', async () => {
  const res = await request(app).get('/crash').expect(500)
  expect(res.body.error).toMatchObject({
    code: 'internal',
    message: 'Something went wrong on our side. Try again.',
  })
  expect(JSON.stringify(res.body)).not.toContain('hunter2')
})
