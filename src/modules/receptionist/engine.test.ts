import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createShop, resetDb, type Shop } from '../../../test/helpers.ts'
import { db } from '../../db/client.ts'
import {
  auditEvents,
  callbackRequests,
  calls,
  consentEvents,
  jobs,
  messages,
  serviceAreaZips,
  tenants,
} from '../../db/schema.ts'
import { HttpError } from '../../lib/http-error.ts'
import { type ChatReply, chat, LlmUnavailable, type ToolCall } from '../llm/llm.ts'
import { endCall, handleTurn, startCall } from './engine.ts'
import { CALL_CONSENT_QUESTION } from './prompt.ts'
import { SAFETY_SCRIPT, SAFETY_SCRIPT_NO_TRANSFER } from './safety.ts'
import { getSession } from './session.ts'
import { runTool } from './tools.ts'

// Never a real model: each test scripts the replies chat() gives, in order.
vi.mock('../llm/llm.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../llm/llm.ts')>()),
  chat: vi.fn(),
}))
// Ending a call queues its wrap-up; no job runner in tests.
vi.mock('../../jobs/boss.ts', () => ({ queueJob: vi.fn() }))

const MARIA = '+16025550111' // the shop's customer
const OFFICE = '+16025550100'
const ON_CALL = '+16025550199'

beforeEach(async () => {
  await resetDb()
  vi.mocked(chat).mockReset()
})

function says(text: string): ChatReply {
  return { text, toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } }
}

function uses(...toolCalls: Omit<ToolCall, 'id'>[]): ChatReply {
  return {
    text: '',
    toolCalls: toolCalls.map((call) => ({ ...call, id: randomUUID() })),
    usage: { inputTokens: 0, outputTokens: 0 },
  }
}

function script(...replies: ChatReply[]) {
  for (const reply of replies) vi.mocked(chat).mockResolvedValueOnce(reply)
}

async function servingShop() {
  const shop = await createShop('desert')
  await db.insert(serviceAreaZips).values({ tenantId: shop.tenant.id, zip: '85004' })
  return shop
}

function setPhones(shop: Shop, phones: { officePhone?: string; onCallPhone?: string }) {
  return db.update(tenants).set(phones).where(eq(tenants.id, shop.tenant.id))
}

function call(shop: Shop, fromPhone: string | null = MARIA) {
  return startCall(shop.tenant.id, {
    providerSid: `test-${randomUUID()}`,
    fromPhone,
    toPhone: OFFICE,
  })
}

async function callRow(callId: string) {
  const [row] = await db.select().from(calls).where(eq(calls.id, callId))
  return row
}

const booking = {
  windowKey: 'W1',
  serviceKey: 'S1',
  problem: 'No heat',
  systemType: 'furnace',
  vulnerableOccupant: false,
  name: 'Maria Lopez',
  street: '12 Palm St',
  city: 'Phoenix',
  state: 'AZ',
  zip: '85004',
  textConsent: true,
}

describe('startCall', () => {
  it('saves the call as the AI’s, disclosed, matched to the customer, and greets', async () => {
    const shop = await servingShop()

    const { callId, say } = await call(shop)

    expect(await callRow(callId)).toMatchObject({
      answeredBy: 'ai',
      disclosedAt: expect.any(Date),
      customerId: shop.customer.id,
      fromPhone: MARIA,
    })
    expect(say).toContain('AI')
    expect(say).toContain('recorded')
    // The model learns the returning caller's address, never an id.
    expect(getSession(callId).system).toContain('12 Palm St, Phoenix')
    expect(getSession(callId).system).not.toContain(shop.service.id)
  })
})

describe('handleTurn', () => {
  it('books a visit: priority, source ai, the call linked, the spoken consent kept', async () => {
    const shop = await servingShop()
    const { callId } = await call(shop)
    script(
      uses(
        { name: 'flag_priority', input: { reason: 'Mother is 90, no heat' } },
        { name: 'check_service_area', input: { zip: '85004' } },
      ),
      uses({ name: 'get_open_windows', input: {} }),
      says('I can come Tuesday between 8 AM and noon. Does that work?'),
      uses({ name: 'book_visit', input: booking }),
      says('You’re booked. Anything else?'),
    )

    const first = await handleTurn(callId, 'No heat, and my mother is 90. ZIP 85004.')
    expect(first).toMatchObject({
      say: 'I can come Tuesday between 8 AM and noon. Does that work?',
      action: null,
    })
    const second = await handleTurn(callId, 'Yes please, and yes to texts.')
    expect(second.say).toBe('You’re booked. Anything else?')
    expect(second.events).toEqual([
      expect.objectContaining({
        type: 'tool',
        name: 'book_visit',
        ok: true,
        job: expect.any(Object),
      }),
    ])

    const [job] = await db.select().from(jobs).where(eq(jobs.callId, callId))
    expect(job).toMatchObject({ source: 'ai', priority: true, vulnerableOccupant: true })
    expect((await callRow(callId)).priority).toBe(true)
    expect(await db.select().from(consentEvents)).toEqual([
      expect.objectContaining({ source: 'call', callId, wording: CALL_CONSENT_QUESTION }),
    ])
    const [confirmation] = await db
      .select()
      .from(messages)
      .where(eq(messages.kind, 'booking_confirmation'))
    expect(confirmation.status).toBe('queued')
    const [audit] = await db.select().from(auditEvents)
    expect(audit).toMatchObject({ actorType: 'ai', action: 'job.booked' })

    // The model was told the booking went through.
    const toolTurns = getSession(callId).messages.filter((message) => message.role === 'tool')
    expect(toolTurns.at(-1)).toMatchObject({ results: [{ name: 'book_visit' }] })
    expect(JSON.stringify(toolTurns.at(-1))).toContain('booked')
  })

  it('answers gas with the safety script and the on-call phone, without asking the model', async () => {
    const shop = await servingShop()
    await setPhones(shop, { onCallPhone: ON_CALL })
    const { callId } = await call(shop)

    const reply = await handleTurn(callId, 'I smell gas in the kitchen')

    expect(reply).toEqual({
      say: SAFETY_SCRIPT,
      action: { type: 'transfer', to: ON_CALL },
      events: [{ type: 'safety' }],
    })
    expect(chat).not.toHaveBeenCalled()
    expect(await callRow(callId)).toMatchObject({
      safetyFlag: true,
      transferredAt: expect.any(Date),
    })
    // Every later turn gets the script again, still without the model.
    expect((await handleTurn(callId, 'Can you book me for tomorrow?')).say).toBe(SAFETY_SCRIPT)
    expect(chat).not.toHaveBeenCalled()
  })

  it('tells the caller to call 911 and hangs up when nobody is on call', async () => {
    const shop = await servingShop()
    const { callId } = await call(shop)

    const reply = await handleTurn(callId, 'Our carbon monoxide alarm is going off')

    expect(reply).toMatchObject({ say: SAFETY_SCRIPT_NO_TRANSFER, action: { type: 'hang_up' } })
  })

  it('takes the safety path when the model reports it', async () => {
    const shop = await servingShop()
    await setPhones(shop, { onCallPhone: ON_CALL })
    const { callId } = await call(shop)
    script(uses({ name: 'report_safety_issue', input: { what: 'sulfur smell by the heater' } }))

    const reply = await handleTurn(callId, 'There is a weird sulfur smell by the water heater')

    expect(reply.say).toBe(SAFETY_SCRIPT)
    expect((await callRow(callId)).safetyFlag).toBe(true)
  })

  it('transfers to the office when the caller asks for a person', async () => {
    const shop = await servingShop()
    await setPhones(shop, { officePhone: OFFICE })
    const { callId } = await call(shop)
    script(uses({ name: 'transfer_to_human', input: { reason: 'Caller asked for a person' } }))

    const reply = await handleTurn(callId, 'Can I talk to a real person?')

    expect(reply.action).toEqual({ type: 'transfer', to: OFFICE })
    expect((await callRow(callId)).transferredAt).toBeInstanceOf(Date)
  })

  it('tells the model to take a message when there is nobody to transfer to', async () => {
    const shop = await servingShop()
    const { callId } = await call(shop)
    script(
      uses({ name: 'transfer_to_human', input: { reason: 'Asked for a person' } }),
      uses({ name: 'take_message', input: { message: 'Wants a person to call back' } }),
      says('I’ve passed your message on. Someone will call you back.'),
    )

    const reply = await handleTurn(callId, 'Let me talk to someone')

    expect(reply.action).toBeNull()
    expect(JSON.stringify(getSession(callId).messages)).toContain('Nobody can take the call')
    expect(await db.select().from(callbackRequests)).toEqual([
      expect.objectContaining({ callId, phone: MARIA, source: 'ai' }),
    ])
  })

  it('saves a message and hangs up politely when the model is unavailable', async () => {
    const shop = await servingShop()
    const { callId } = await call(shop)
    vi.mocked(chat).mockRejectedValueOnce(new LlmUnavailable('timed out'))

    const reply = await handleTurn(callId, 'My AC is broken')

    expect(reply.action).toEqual({ type: 'hang_up' })
    expect(reply.say).toContain('call you back')
    const [callback] = await db.select().from(callbackRequests)
    expect(callback).toMatchObject({ callId, phone: MARIA, source: 'ai' })
    expect(callback.message).toContain('My AC is broken')
  })

  it('gives up after four tool rounds without an answer', async () => {
    const shop = await servingShop()
    const { callId } = await call(shop)
    vi.mocked(chat).mockResolvedValue(uses({ name: 'get_open_windows', input: {} }))

    const reply = await handleTurn(callId, 'When can you come?')

    expect(chat).toHaveBeenCalledTimes(4)
    expect(reply.action).toEqual({ type: 'hang_up' })
    expect(await db.select().from(callbackRequests)).toHaveLength(1)
  })

  it('answers 404 once the call has ended', async () => {
    const shop = await servingShop()
    const { callId } = await call(shop)

    await endCall(callId)

    expect((await callRow(callId)).endedAt).toBeInstanceOf(Date)
    await expect(handleTurn(callId, 'Hello?')).rejects.toBeInstanceOf(HttpError)
    await endCall(callId) // a second end does nothing
  })
})

describe('book_visit', () => {
  async function bookingCall() {
    const shop = await servingShop()
    const { callId } = await call(shop)
    const session = getSession(callId)
    await runTool(session, { id: 't1', name: 'get_open_windows', input: {} })
    return session
  }
  const book = (input: object) => ({ id: randomUUID(), name: 'book_visit', input })

  it('refuses a window it never offered, and books only once', async () => {
    const session = await bookingCall()

    expect((await runTool(session, book({ ...booking, windowKey: 'W9' }))).output).toContain(
      'Offer windows from get_open_windows first',
    )
    expect((await runTool(session, book(booking))).output).toContain('"booked":true')
    expect((await runTool(session, book(booking))).output).toContain('Already booked')
    expect(await db.select().from(jobs)).toHaveLength(1)
  })

  it('never books a safety call, whatever the model says', async () => {
    const session = await bookingCall()
    session.safety = true

    expect((await runTool(session, book(booking))).output).toContain('safety issue')
    expect(await db.select().from(jobs)).toHaveLength(0)
  })

  it('asks for a phone number when caller ID is hidden', async () => {
    const shop = await servingShop()
    const { callId } = await call(shop, null)
    const session = getSession(callId)
    await runTool(session, { id: 't1', name: 'get_open_windows', input: {} })

    expect((await runTool(session, book(booking))).output).toContain('phone number')
    expect(
      (await runTool(session, book({ ...booking, phone: '(602) 555-0123' }))).output,
    ).toContain('"booked":true')
  })

  it('passes the booking’s own refusals to the model, like a ZIP outside the area', async () => {
    const session = await bookingCall()

    const result = await runTool(session, book({ ...booking, zip: '90210' }))

    expect(JSON.parse(result.output)).toEqual({ error: 'We don’t serve ZIP code 90210 yet.' })
  })

  it('books without a text consent when the caller said no', async () => {
    const session = await bookingCall()

    await runTool(session, book({ ...booking, textConsent: false }))

    expect(await db.select().from(consentEvents)).toHaveLength(0)
    const [confirmation] = await db
      .select()
      .from(messages)
      .where(eq(messages.kind, 'booking_confirmation'))
    expect(confirmation.status).toBe('blocked')
  })
})
