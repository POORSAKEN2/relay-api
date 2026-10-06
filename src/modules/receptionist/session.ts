import type { Tenant } from '../../db/schema.ts'
import { HttpError } from '../../lib/http-error.ts'
import type { ChatMessage } from '../llm/llm.ts'

// What the AI does to the call itself, besides talking.
export type Action = { type: 'transfer'; to: string } | { type: 'hang_up' }

// One call in progress. Kept in memory: a phone call lives on one connection to this one
// process, and if the process restarts mid-call the call drops anyway.
export type CallSession = {
  callId: string
  tenant: Tenant
  fromPhone: string | null // null when the caller hid their number
  system: string // the system prompt, built once when the call starts
  messages: ChatMessage[] // what the model has seen
  turns: { speaker: 'caller' | 'ai'; text: string; at: Date }[] // for the transcript
  // The model sees short keys, never ids: 'S1' → service id, 'W1' → an offered window.
  services: Map<string, string>
  windows: Map<string, { windowId: string; date: string; label: string }>
  zip: string | null
  priority: boolean
  safety: boolean // gas or CO was mentioned: no booking from now on
  bookedJobId: string | null
  lastActivity: Date
}

const sessions = new Map<string, CallSession>()

export function saveSession(session: CallSession) {
  sessions.set(session.callId, session)
}

// The call in progress, or a 404: it ended, or never existed.
export function getSession(callId: string): CallSession {
  const session = sessions.get(callId)
  if (!session) throw new HttpError(404, 'not_found', 'That call has ended.')
  return session
}

export function findSession(callId: string): CallSession | undefined {
  return sessions.get(callId)
}

export function forgetSession(callId: string) {
  sessions.delete(callId)
}
