import { z } from 'zod'
import { SYSTEM_TYPES } from '../../db/schema.ts'
import { Phone, Zip } from '../../lib/fields.ts'
import { HttpError } from '../../lib/http-error.ts'
import { weekdayOf } from '../../lib/labels.ts'
import { localTime, localToday } from '../../lib/local-day.ts'
import { logger } from '../../lib/logger.ts'
import { listWindowsOn } from '../dispatch/dispatch.queries.ts'
import type { ToolCall, ToolSpec } from '../llm/llm.ts'
import { insertCallback, listOpenWindows } from '../online-booking/online-booking.queries.ts'
import { BookingInput } from '../online-booking/online-booking.schemas.ts'
import { bookHomeownerVisit } from '../online-booking/online-booking.service.ts'
import { zipIsServed } from '../settings/settings.queries.ts'
import { CALL_CONSENT_QUESTION, spokenWindow } from './prompt.ts'
import * as queries from './receptionist.queries.ts'
import { SAFETY_SCRIPT, SAFETY_SCRIPT_NO_TRANSFER } from './safety.ts'
import type { Action, CallSession } from './session.ts'
import { transferTarget } from './transfer.ts'

// The receptionist's tools. The model asks; the backend decides. Every input is checked
// with zod, and a refused or invalid call answers { error: "<sentence for the model>" } instead
// of throwing, so the model can recover. Every rule that matters lives here, not in the prompt.

const DAYS_AHEAD = 14 // the same two weeks the booking page offers
const WINDOWS_OFFERED = 6

// A tool that ends the conversation (transfer, safety) also gives the fixed line to say.
export type Handoff = { say: string; action: Action }
export type ToolResult = { output: string; handoff?: Handoff }

const CheckServiceArea = z.object({ zip: Zip.describe('The 5-digit ZIP code of the home') })
const NoInput = z.object({})
const FlagPriority = z.object({
  reason: z.string().min(1).describe('Who is at risk, e.g. "90-year-old mother, no heat"'),
})
const BookVisit = z.object({
  windowKey: z.string().describe('The key of an offered window, e.g. "W1"'),
  serviceKey: z.string().describe('The key of a service from the list, e.g. "S1"'),
  problem: z.string().min(1).describe('The problem in the caller’s words'),
  systemType: z.enum(SYSTEM_TYPES).describe('Use not_sure when the caller doesn’t know'),
  vulnerableOccupant: z.boolean().describe('Someone elderly, an infant or medically fragile'),
  name: z.string().min(1),
  street: z.string().min(1),
  unit: z.string().optional(),
  city: z.string().min(1),
  state: z.string().describe('Two letters, e.g. "AZ"'),
  zip: z.string(),
  phone: z.string().optional().describe('Only if the caller gave a different number to use'),
  textConsent: z.boolean().describe('True only if the caller clearly said yes to texts'),
})
const TakeMessage = z.object({
  name: z.string().optional(),
  phone: z.string().optional().describe('Only if the caller gave a number to call back'),
  message: z.string().min(1).describe('What the caller needs, for the office'),
})
const TransferToHuman = z.object({ reason: z.string().min(1) })
const ReportSafetyIssue = z.object({ what: z.string().min(1) })

// The model reads these descriptions: they say when to use each tool.
export const TOOL_SPECS: ToolSpec[] = [
  spec('check_service_area', 'Check whether a ZIP code is in the service area.', CheckServiceArea),
  spec(
    'get_open_windows',
    'List the open arrival windows, soonest first, with their keys (W1, W2...).',
    NoInput,
  ),
  spec(
    'flag_priority',
    'Mark the call as priority: no heat or cooling and someone vulnerable at home.',
    FlagPriority,
  ),
  spec(
    'book_visit',
    'Book the visit, only after the caller said yes to the booking read back to them.',
    BookVisit,
  ),
  spec(
    'take_message',
    'Save a message for the office to call back: outside the service area, or anything you can’t do.',
    TakeMessage,
  ),
  spec(
    'transfer_to_human',
    'Hand the call to a person, when the caller asks for one.',
    TransferToHuman,
  ),
  spec(
    'report_safety_issue',
    'Use at once for a gas, burning or rotten-egg smell, or a carbon monoxide alarm.',
    ReportSafetyIssue,
  ),
]

// Runs one tool call the model asked for.
export async function runTool(session: CallSession, call: ToolCall): Promise<ToolResult> {
  switch (call.name) {
    case 'check_service_area':
      return checkServiceArea(session, call.input)
    case 'get_open_windows':
      return getOpenWindows(session)
    case 'flag_priority':
      return flagPriority(session, call.input)
    case 'book_visit':
      return bookVisit(session, call.input)
    case 'take_message':
      return takeMessage(session, call.input)
    case 'transfer_to_human':
      return transferToHuman(session, call.input)
    case 'report_safety_issue':
      return startSafety(session)
    default:
      return error(`There is no tool called ${call.name}.`)
  }
}

async function checkServiceArea(session: CallSession, input: unknown): Promise<ToolResult> {
  const parsed = CheckServiceArea.safeParse(input)
  if (!parsed.success) return error('Ask for the 5-digit ZIP code.')
  const served = await zipIsServed(session.tenant.id, parsed.data.zip)
  session.zip = parsed.data.zip
  return ok({ zip: parsed.data.zip, served })
}

async function getOpenWindows(session: CallSession): Promise<ToolResult> {
  const rows = (await listOpenWindows(session.tenant.id, DAYS_AHEAD)).slice(0, WINDOWS_OFFERED)
  session.windows.clear()
  const windows = rows.map((row, index) => {
    const key = `W${index + 1}`
    const label = spokenWindow(row.date, row.startsAt, row.endsAt)
    session.windows.set(key, { windowId: row.id, date: row.date, label })
    return { key, when: label }
  })
  if (windows.length === 0) {
    return ok({ windows, note: 'Nothing is open in the next two weeks. Take a message.' })
  }
  return ok({ windows })
}

async function flagPriority(session: CallSession, input: unknown): Promise<ToolResult> {
  if (!FlagPriority.safeParse(input).success) return error('Say who is at risk.')
  session.priority = true
  await queries.updateCall(session.tenant.id, session.callId, { priority: true })
  return ok({ priority: true })
}

async function bookVisit(session: CallSession, input: unknown): Promise<ToolResult> {
  // Whatever the model says, a gas or CO call is never booked.
  if (session.safety) return error('This call is a safety issue. Do not book a visit.')
  if (session.bookedJobId) return error('Already booked this call. Don’t book it again.')
  const parsed = BookVisit.safeParse(input)
  if (!parsed.success) return error(`Some details are missing or wrong: ${issues(parsed.error)}`)
  const visit = parsed.data

  // Only windows the AI actually offered, and services from its list.
  const window = session.windows.get(visit.windowKey)
  if (!window) return error('Offer windows from get_open_windows first, then use their key.')
  const serviceId = session.services.get(visit.serviceKey)
  if (!serviceId) return error('Use a service key from the list, like S1.')
  const phone = visit.phone ?? session.fromPhone
  if (!phone) return error('Ask the caller for a phone number to book the visit with.')

  // The web form's own checks: phone, state and ZIP formats.
  const booking = BookingInput.safeParse({
    serviceId,
    date: window.date,
    windowId: window.windowId,
    problem: visit.problem,
    systemType: visit.systemType,
    vulnerableOccupant: visit.vulnerableOccupant || session.priority,
    name: visit.name,
    phone,
    street: visit.street,
    unit: visit.unit,
    city: visit.city,
    state: visit.state,
    zip: visit.zip,
  })
  if (!booking.success) return error(`Some details are missing or wrong: ${issues(booking.error)}`)

  try {
    const { jobId } = await bookHomeownerVisit(session.tenant, booking.data, {
      source: 'ai',
      callId: session.callId,
      ip: null,
      consent: visit.textConsent ? { source: 'call', wording: CALL_CONSENT_QUESTION } : null,
    })
    session.bookedJobId = jobId
    return ok({ booked: true, when: window.label })
  } catch (failure) {
    // A window that filled during the call, a ZIP outside the area...: the model is told and
    // offers something else.
    if (failure instanceof HttpError) return error(failure.message)
    throw failure
  }
}

async function takeMessage(session: CallSession, input: unknown): Promise<ToolResult> {
  const parsed = TakeMessage.safeParse(input)
  if (!parsed.success) return error('Say what the caller needs in the message.')
  const phone = Phone.safeParse(parsed.data.phone ?? session.fromPhone ?? '').data
  if (!phone) return error('Ask for a phone number so the office can call back.')
  await insertCallback(session.tenant.id, {
    callId: session.callId,
    name: parsed.data.name ?? null,
    phone,
    zip: session.zip,
    message: parsed.data.message,
    source: 'ai',
  })
  return ok({ saved: true })
}

async function transferToHuman(session: CallSession, input: unknown): Promise<ToolResult> {
  if (!TransferToHuman.safeParse(input).success) return error('Give a reason for the transfer.')
  const to = await findTransferTarget(session)
  if (!to) return error('Nobody can take the call right now. Offer to take a message instead.')
  await queries.updateCall(session.tenant.id, session.callId, { transferredAt: new Date() })
  return {
    output: JSON.stringify({ transferring: true }),
    handoff: {
      say: 'Of course. I’m connecting you now, please hold.',
      action: { type: 'transfer', to },
    },
  }
}

// Gas or CO: the fixed safety script, then the on-call technician (or 911 when there is
// nobody on call). Runs from the keyword check and from the model's report_safety_issue;
// safe to run again on a later turn.
export async function startSafety(
  session: CallSession,
): Promise<{ output: string; handoff: Handoff }> {
  const output = JSON.stringify({ safety: true })
  const to = session.tenant.onCallPhone
  if (!session.safety) {
    session.safety = true
    logger.warn({ callId: session.callId }, 'Receptionist: gas or CO call')
    await queries.updateCall(session.tenant.id, session.callId, {
      safetyFlag: true,
      ...(to ? { transferredAt: new Date() } : {}),
    })
  }
  if (!to)
    return { output, handoff: { say: SAFETY_SCRIPT_NO_TRANSFER, action: { type: 'hang_up' } } }
  return { output, handoff: { say: SAFETY_SCRIPT, action: { type: 'transfer', to } } }
}

// The office during today's business hours, the on-call phone after (see transfer.ts).
async function findTransferTarget(session: CallSession) {
  const { tenant } = session
  const today = localToday(tenant.timezone)
  const windows = await listWindowsOn(tenant.id, weekdayOf(today))
  return transferTarget(tenant, windows, localTime(tenant.timezone))
}

function ok(result: object): ToolResult {
  return { output: JSON.stringify(result) }
}

function error(message: string): ToolResult {
  return { output: JSON.stringify({ error: message }) }
}

// 'name: Enter your name; zip: …', for the model to ask again.
function issues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
}

// A tool's JSON Schema comes from its zod schema, so the two never disagree.
function spec(name: string, description: string, input: z.ZodObject): ToolSpec {
  const { $schema, ...schema } = z.toJSONSchema(input) as Record<string, unknown>
  return { name, description, parameters: schema as ToolSpec['parameters'] }
}
