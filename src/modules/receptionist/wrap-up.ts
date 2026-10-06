import { db } from '../../db/client.ts'
import { formatDay, formatWindow } from '../../lib/labels.ts'
import { logger } from '../../lib/logger.ts'
import { emitToTenant } from '../../realtime/index.ts'
import { insertNote } from '../dispatch/dispatch.queries.ts'
import { chat, LlmUnavailable } from '../llm/llm.ts'
import * as queries from './receptionist.queries.ts'

const SUMMARY_PROMPT =
  'Summarize this phone call for an HVAC office in at most three short sentences: what the caller needed, what was done (booked, message taken, transferred, safety script), and anything the office or technician must follow up on. Plain text, no greeting.'

// After an AI call ends ('call-wrapup' job): a short summary for the office, on the call and
// on the job it booked, where the office and the technician already read notes. A job, so the
// caller's hang-up isn't held up by the model. Safe to run twice: only the first run writes.
export async function wrapUpCall(tenantId: string, callId: string) {
  const call = await queries.findCallToWrapUp(tenantId, callId)
  if (!call || call.summary) return // gone, or already done

  const summary = (await summarize(call.transcript)) ?? plainSummary(call)
  const saved = await db.transaction(async (tx) => {
    if (!(await queries.saveSummary(tenantId, callId, summary, tx))) return false
    if (call.jobId) {
      await insertNote(
        tenantId,
        { jobId: call.jobId, authorId: null, body: `Call summary (AI): ${summary}` },
        tx,
      )
    }
    return true
  })
  if (!saved) return

  if (call.jobId && call.jobDate) {
    emitToTenant(tenantId, 'job.note_added', { jobId: call.jobId, dates: [call.jobDate] })
  }
  emitToTenant(tenantId, 'call.handled', { callId })
}

// The model's summary of the transcript, or null when there is no transcript or the model
// can't answer: the plain summary is used instead.
async function summarize(transcript: string | null): Promise<string | null> {
  if (!transcript) return null
  try {
    const reply = await chat({
      system: SUMMARY_PROMPT,
      messages: [{ role: 'user', text: transcript }],
      tools: [],
      maxTokens: 200,
    })
    return reply.text.trim() || null
  } catch (error) {
    if (!(error instanceof LlmUnavailable)) throw error
    logger.warn({ reason: error.message }, 'Call summary written without the model')
    return null
  }
}

// A summary from the facts alone, the most important first.
export function plainSummary(call: {
  safetyFlag: boolean
  transferredAt: Date | null
  messageTaken: boolean
  jobDate: string | null
  jobStartsAt: string | null
  jobEndsAt: string | null
}): string {
  if (call.safetyFlag) return 'AI call. Safety script (gas or CO).'
  if (call.jobDate && call.jobStartsAt && call.jobEndsAt) {
    return `AI call. Booked ${formatDay(call.jobDate)}, ${formatWindow(call.jobStartsAt, call.jobEndsAt)}.`
  }
  if (call.transferredAt) return 'AI call. Transferred to staff.'
  if (call.messageTaken) return 'AI call. Message taken.'
  return 'AI call. Nothing booked and no message taken.'
}
