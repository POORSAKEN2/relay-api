import { randomUUID } from 'node:crypto'
import { HttpError } from '../../lib/http-error.ts'
import { findSendingNumber } from '../messaging/messaging.queries.ts'
import { endCall, handleTurn, startCall } from './engine.ts'
import * as queries from './receptionist.queries.ts'
import { findSession } from './session.ts'

// The test console: a call to the receptionist from a browser, before any phone line exists.
// It runs the same engine as a real call, so its calls and bookings are real rows.

export async function startTestCall(tenantId: string, fromPhone: string | null) {
  // Looks like a phone call: to the contractor's own number, or their contact phone.
  const tenant = await queries.findTenant(tenantId)
  const toPhone = (await findSendingNumber(tenantId)) ?? tenant.contactPhone
  return startCall(tenantId, { providerSid: `test-${randomUUID()}`, fromPhone, toPhone })
}

export async function testTurn(tenantId: string, callId: string, text: string) {
  checkOwnCall(tenantId, callId)
  return handleTurn(callId, text)
}

export async function endTestCall(tenantId: string, callId: string) {
  checkOwnCall(tenantId, callId)
  await endCall(callId)
}

// A call that ended, or another contractor's, is "not found": nothing to say about it.
function checkOwnCall(tenantId: string, callId: string) {
  if (findSession(callId)?.tenant.id !== tenantId) {
    throw new HttpError(404, 'not_found', 'That call has ended.')
  }
}
