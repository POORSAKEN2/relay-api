import { formatMoney } from '../../lib/labels.ts'
import { logger } from '../../lib/logger.ts'
import { chat, LlmUnavailable } from '../llm/llm.ts'
import { insertCallback, listServices } from '../online-booking/online-booking.queries.ts'
import { buildSystemPrompt, CALL_BACK_LINE, greeting } from './prompt.ts'
import * as queries from './receptionist.queries.ts'
import { mentionsGasOrCo } from './safety.ts'
import {
  type Action,
  type CallSession,
  findSession,
  forgetSession,
  getSession,
  saveSession,
} from './session.ts'
import { type Handoff, runTool, startSafety, TOOL_SPECS } from './tools.ts'

// The AI receptionist: text in, text out. A phone line (or the test console) turns the
// caller's speech into text, calls handleTurn, and speaks what comes back.

// Model rounds per caller turn. A model that keeps calling tools without answering is stuck.
const MAX_TOOL_ROUNDS = 4

// When nobody can be called back (caller ID hidden and no number given).
const NO_CALL_BACK_LINE =
  'I’m sorry, I’m having trouble on my end. Please call us back in a few minutes. Goodbye.'

export type TurnReply = { say: string; action: Action | null }

// Answers a call: saves it as answered by the AI, with the disclosure, and returns the
// greeting. The greeting is fixed text, never the model's.
export async function startCall(
  tenantId: string,
  call: { providerSid: string; fromPhone: string | null; toPhone: string },
): Promise<{ callId: string; say: string }> {
  const tenant = await queries.findTenant(tenantId)
  const caller = call.fromPhone
    ? await queries.findCallerContext(tenantId, call.fromPhone)
    : undefined
  const services = await listServices(tenantId)
  const callId = await queries.insertAiCall(tenantId, { ...call, customerId: caller?.customerId })

  const system = buildSystemPrompt({
    tenantName: tenant.name,
    today: new Intl.DateTimeFormat('en-US', {
      timeZone: tenant.timezone,
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    }).format(new Date()),
    services: services.map((service, index) => ({
      key: `S${index + 1}`,
      name: service.name,
      feeLabel: feeLabel(service),
    })),
    caller: caller ? { name: caller.name, addresses: caller.addresses } : null,
  })
  const say = greeting(tenant.name)
  saveSession({
    callId,
    tenant,
    fromPhone: call.fromPhone,
    system,
    messages: [],
    turns: [{ speaker: 'ai', text: say, at: new Date() }],
    services: new Map(services.map((service, index) => [`S${index + 1}`, service.id])),
    windows: new Map(),
    zip: null,
    priority: false,
    safety: false,
    bookedJobId: null,
    lastActivity: new Date(),
  })
  return { callId, say }
}

// One thing the caller said → what to say back, and what to do with the call, if anything.
export async function handleTurn(callId: string, callerText: string): Promise<TurnReply> {
  const session = getSession(callId)
  addTurn(session, 'caller', callerText)

  // Checked before the model sees the words, so no reply can talk past a gas leak.
  if (session.safety || mentionsGasOrCo(callerText)) {
    const { handoff } = await startSafety(session)
    return reply(session, handoff.say, handoff.action)
  }

  session.messages.push({ role: 'user', text: callerText })
  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const answer = await chat({
        system: session.system,
        messages: session.messages,
        tools: TOOL_SPECS,
      })
      session.messages.push({ role: 'assistant', text: answer.text, toolCalls: answer.toolCalls })
      if (answer.toolCalls.length === 0) return reply(session, answer.text, null)

      // Run every tool the model asked for, and send all the results back together.
      const results = []
      let handoff: Handoff | undefined
      for (const call of answer.toolCalls) {
        const result = await runTool(session, call)
        results.push({ toolCallId: call.id, name: call.name, output: result.output })
        handoff ??= result.handoff
      }
      session.messages.push({ role: 'tool', results })
      // A transfer or the safety script ends the conversation: the fixed line, no more model.
      if (handoff) return reply(session, handoff.say, handoff.action)
    }
    const stuck = await giveUp(session, 'too many tool rounds')
    return reply(session, stuck.say, stuck.action)
  } catch (error) {
    if (!(error instanceof LlmUnavailable)) throw error
    const failed = await giveUp(session, error.message)
    return reply(session, failed.say, failed.action)
  }
}

// The call is over: when it ended is saved and the session forgotten. Ending a call twice
// does nothing the second time.
export async function endCall(callId: string) {
  const session = findSession(callId)
  if (!session) return
  forgetSession(callId)
  await queries.updateCall(session.tenant.id, callId, { endedAt: new Date() })
}

// The model failed or got stuck. The caller is never left in silence: whatever they said is
// saved as a message for the office, and the call ends politely.
async function giveUp(session: CallSession, reason: string): Promise<Handoff> {
  logger.warn({ callId: session.callId, reason }, 'Receptionist gave up: message taken')
  if (!session.fromPhone) return { say: NO_CALL_BACK_LINE, action: { type: 'hang_up' } }
  const said = session.turns
    .filter((turn) => turn.speaker === 'caller')
    .map((turn) => turn.text)
    .join(' / ')
  await insertCallback(session.tenant.id, {
    callId: session.callId,
    phone: session.fromPhone,
    zip: session.zip,
    message: `The AI couldn’t finish this call. The caller said: ${said}`.slice(0, 2000),
    source: 'ai',
  })
  return { say: CALL_BACK_LINE, action: { type: 'hang_up' } }
}

function reply(session: CallSession, say: string, action: Action | null): TurnReply {
  addTurn(session, 'ai', say)
  return { say, action }
}

function addTurn(session: CallSession, speaker: 'caller' | 'ai', text: string) {
  session.turns.push({ speaker, text, at: new Date() })
  session.lastActivity = new Date()
}

// '$89 diagnostic fee', '$129', 'free'. Said to the caller; never a repair price.
function feeLabel(service: { priceType: string; priceCents: number }): string {
  if (service.priceType === 'free') return 'free'
  const money = formatMoney(service.priceCents, 'USD')
  return service.priceType === 'diagnostic' ? `${money} diagnostic fee` : money
}
