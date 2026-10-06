import { eq } from 'drizzle-orm'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createShop, resetDb, signInTechnician } from '../../../test/helpers.ts'
import { createApp } from '../../app.ts'
import { env } from '../../config/env.ts'
import { db } from '../../db/client.ts'
import { calls } from '../../db/schema.ts'
import { chat } from '../llm/llm.ts'

vi.mock('../llm/llm.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../llm/llm.ts')>()),
  chat: vi.fn(),
}))
// Ending a call queues its wrap-up; no job runner in tests.
vi.mock('../../jobs/boss.ts', () => ({ queueJob: vi.fn() }))

const app = createApp()

beforeEach(async () => {
  await resetDb()
  vi.mocked(chat).mockReset()
  env.RECEPTIONIST_TEST_CONSOLE = true
})
afterEach(() => {
  env.RECEPTIONIST_TEST_CONSOLE = false
})

function post(path: string, cookie: string, body: object = {}) {
  return request(app).post(`/api/receptionist/${path}`).set('Cookie', cookie).send(body)
}

describe('receptionist test console', () => {
  it('starts a call, answers a turn and hangs up', async () => {
    const shop = await createShop('desert')
    vi.mocked(chat).mockResolvedValueOnce({
      text: 'Sorry to hear that. What is your ZIP code?',
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    })

    const started = await post('test-calls', shop.cookie, { fromPhone: '(602) 555-0111' }).expect(
      201,
    )
    expect(started.body).toEqual({ callId: expect.any(String), say: expect.stringContaining('AI') })
    const { callId } = started.body
    const [call] = await db.select().from(calls).where(eq(calls.id, callId))
    expect(call).toMatchObject({
      providerSid: expect.stringMatching(/^test-/),
      fromPhone: '+16025550111',
      toPhone: '+14805550100', // the contact phone: the shop has no number of its own
      answeredBy: 'ai',
    })

    const turn = await post(`test-calls/${callId}/turns`, shop.cookie, {
      text: 'My AC is out',
    }).expect(200)
    expect(turn.body).toEqual({
      say: 'Sorry to hear that. What is your ZIP code?',
      action: null,
      events: [],
    })

    await post(`test-calls/${callId}/end`, shop.cookie).expect(204)
    await post(`test-calls/${callId}/turns`, shop.cookie, { text: 'Hello?' }).expect(404)
    await post(`test-calls/${callId}/end`, shop.cookie).expect(404)
  })

  it('starts a call from a hidden number', async () => {
    const shop = await createShop('desert')
    const { body } = await post('test-calls', shop.cookie).expect(201)
    const [call] = await db.select().from(calls).where(eq(calls.id, body.callId))
    expect(call.fromPhone).toBeNull()
  })

  it('keeps another contractor out of a call', async () => {
    const shop = await createShop('desert')
    const other = await createShop('other')
    const { body } = await post('test-calls', shop.cookie).expect(201)

    await post(`test-calls/${body.callId}/turns`, other.cookie, { text: 'Hi' }).expect(404)
    await post(`test-calls/${body.callId}/end`, other.cookie).expect(404)
    expect(chat).not.toHaveBeenCalled()
  })

  it('checks what is said', async () => {
    const shop = await createShop('desert')
    const { body } = await post('test-calls', shop.cookie).expect(201)
    await post(`test-calls/${body.callId}/turns`, shop.cookie, { text: '  ' }).expect(400)
    await post(`test-calls/${body.callId}/turns`, shop.cookie, { text: 'x'.repeat(1001) }).expect(
      400,
    )
    await post('test-calls/nope/turns', shop.cookie, { text: 'Hi' }).expect(400)
  })

  it('is for owner and office only', async () => {
    const shop = await createShop('desert')
    await request(app).post('/api/receptionist/test-calls').expect(401)
    await post('test-calls', await signInTechnician(shop.mike)).expect(403)
  })

  it('is not there when switched off, and says so', async () => {
    const shop = await createShop('desert')
    env.RECEPTIONIST_TEST_CONSOLE = false

    await post('test-calls', shop.cookie).expect(404)
    const res = await request(app)
      .get('/api/receptionist/test-console')
      .set('Cookie', shop.cookie)
      .expect(200)
    expect(res.body).toEqual({ on: false })
  })
})
