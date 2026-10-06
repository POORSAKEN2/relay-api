import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createJob, createShop, resetDb, type Shop } from '../../../test/helpers.ts'
import { db } from '../../db/client.ts'
import { callbackRequests, calls, jobNotes } from '../../db/schema.ts'
import { queueJob } from '../../jobs/boss.ts'
import { emitToTenant } from '../../realtime/index.ts'
import { chat, LlmUnavailable } from '../llm/llm.ts'
import { endCall, endIdleCalls, handleTurn, startCall } from './engine.ts'
import { findSession, getSession } from './session.ts'
import { plainSummary, wrapUpCall } from './wrap-up.ts'

vi.mock('../llm/llm.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../llm/llm.ts')>()),
  chat: vi.fn(),
}))
vi.mock('../../jobs/boss.ts', () => ({ queueJob: vi.fn() }))
vi.mock('../../realtime/index.ts', () => ({ emitToTenant: vi.fn() }))

beforeEach(async () => {
  await resetDb()
  vi.mocked(chat).mockReset()
  vi.mocked(queueJob).mockClear()
  vi.mocked(emitToTenant).mockClear()
})

const TRANSCRIPT = 'AI: Thanks for calling.\nCaller: My AC is out.'

// An AI call that ended, with its transcript saved.
async function endedCall(shop: Shop, values: Partial<typeof calls.$inferInsert> = {}) {
  const [call] = await db
    .insert(calls)
    .values({
      tenantId: shop.tenant.id,
      providerSid: randomUUID(),
      fromPhone: '+16025550111',
      toPhone: '+14805550100',
      answeredBy: 'ai',
      disclosedAt: new Date(),
      endedAt: new Date(),
      transcript: TRANSCRIPT,
      ...values,
    })
    .returning()
  return call
}

async function summaryOf(callId: string) {
  const [call] = await db.select().from(calls).where(eq(calls.id, callId))
  return call.summary
}

function modelSays(text: string) {
  vi.mocked(chat).mockResolvedValue({
    text,
    toolCalls: [],
    usage: { inputTokens: 0, outputTokens: 0 },
  })
}

describe('endCall', () => {
  it('saves the transcript and queues the wrap-up', async () => {
    const shop = await createShop('desert')
    const { callId } = await startCall(shop.tenant.id, {
      providerSid: `test-${randomUUID()}`,
      fromPhone: '+16025550111',
      toPhone: '+14805550100',
    })
    modelSays('What is the ZIP code there?')
    await handleTurn(callId, 'My AC is out')

    await endCall(callId)

    const [call] = await db.select().from(calls).where(eq(calls.id, callId))
    expect(call.endedAt).toBeInstanceOf(Date)
    expect(call.transcript).toMatch(/^AI: Thanks for calling desert HVAC\./)
    expect(call.transcript).toContain('\nCaller: My AC is out\nAI: What is the ZIP code there?')
    expect(queueJob).toHaveBeenCalledWith('call-wrapup', { tenantId: shop.tenant.id, callId })
  })
})

describe('wrapUpCall', () => {
  it('puts the summary on the call and on the job it booked, and tells the office', async () => {
    const shop = await createShop('desert')
    const call = await endedCall(shop)
    const job = await createJob(shop, { source: 'ai', callId: call.id })
    modelSays('Caller’s AC is out. Booked Tuesday morning.')

    await wrapUpCall(shop.tenant.id, call.id)

    expect(await summaryOf(call.id)).toBe('Caller’s AC is out. Booked Tuesday morning.')
    expect(await db.select().from(jobNotes)).toEqual([
      expect.objectContaining({
        jobId: job.id,
        authorId: null,
        body: 'Call summary (AI): Caller’s AC is out. Booked Tuesday morning.',
      }),
    ])
    expect(vi.mocked(chat).mock.calls[0][0]).toMatchObject({
      messages: [{ role: 'user', text: TRANSCRIPT }],
      maxTokens: 200,
    })
    expect(emitToTenant).toHaveBeenCalledWith(shop.tenant.id, 'job.note_added', {
      jobId: job.id,
      dates: ['2030-01-08'],
    })
    expect(emitToTenant).toHaveBeenCalledWith(shop.tenant.id, 'call.handled', { callId: call.id })
  })

  it('writes a plain summary when the model is unavailable', async () => {
    const shop = await createShop('desert')
    const call = await endedCall(shop)
    await createJob(shop, { source: 'ai', callId: call.id })
    vi.mocked(chat).mockRejectedValue(new LlmUnavailable('off'))

    await wrapUpCall(shop.tenant.id, call.id)

    expect(await summaryOf(call.id)).toBe('AI call. Booked Tue, Jan 8, 8 AM–12 PM.')
  })

  it('adds the note once, however many times the job runs', async () => {
    const shop = await createShop('desert')
    const call = await endedCall(shop)
    await createJob(shop, { source: 'ai', callId: call.id })
    modelSays('Booked.')

    await wrapUpCall(shop.tenant.id, call.id)
    await wrapUpCall(shop.tenant.id, call.id)

    expect(await db.select().from(jobNotes)).toHaveLength(1)
    expect(chat).toHaveBeenCalledTimes(1)
  })

  it('summarizes a call with no job, without a note', async () => {
    const shop = await createShop('desert')
    const call = await endedCall(shop)
    await db.insert(callbackRequests).values({
      tenantId: shop.tenant.id,
      callId: call.id,
      phone: '+16025550111',
      message: 'Call back about a quote',
      source: 'ai',
    })
    vi.mocked(chat).mockRejectedValue(new LlmUnavailable('off'))

    await wrapUpCall(shop.tenant.id, call.id)

    expect(await summaryOf(call.id)).toBe('AI call. Message taken.')
    expect(await db.select().from(jobNotes)).toHaveLength(0)
    expect(emitToTenant).toHaveBeenCalledTimes(1)
    expect(emitToTenant).toHaveBeenCalledWith(shop.tenant.id, 'call.handled', { callId: call.id })
  })

  it('does nothing for a call of another contractor', async () => {
    const shop = await createShop('desert')
    const other = await createShop('other')
    const call = await endedCall(other)

    await wrapUpCall(shop.tenant.id, call.id)

    expect(await summaryOf(call.id)).toBeNull()
  })
})

describe('plainSummary', () => {
  const nothing = {
    safetyFlag: false,
    transferredAt: null,
    messageTaken: false,
    jobDate: null,
    jobStartsAt: null,
    jobEndsAt: null,
  }

  it('says the most important thing that happened', () => {
    expect(plainSummary({ ...nothing, safetyFlag: true, transferredAt: new Date() })).toBe(
      'AI call. Safety script (gas or CO).',
    )
    expect(plainSummary({ ...nothing, transferredAt: new Date() })).toBe(
      'AI call. Transferred to staff.',
    )
    expect(plainSummary(nothing)).toBe('AI call. Nothing booked and no message taken.')
  })
})

describe('endIdleCalls', () => {
  it('ends calls quiet for over 10 minutes and keeps the others', async () => {
    const shop = await createShop('desert')
    const start = () =>
      startCall(shop.tenant.id, {
        providerSid: `test-${randomUUID()}`,
        fromPhone: null,
        toPhone: '+14805550100',
      })
    const idle = await start()
    const busy = await start()
    const now = new Date()
    getSession(idle.callId).lastActivity = new Date(now.getTime() - 11 * 60_000)
    getSession(busy.callId).lastActivity = new Date(now.getTime() - 5 * 60_000)

    await endIdleCalls(now)

    expect(findSession(idle.callId)).toBeUndefined()
    expect(findSession(busy.callId)).toBeDefined()
    const [ended] = await db.select().from(calls).where(eq(calls.id, idle.callId))
    expect(ended.endedAt).toBeInstanceOf(Date)
    await endCall(busy.callId)
  })
})
