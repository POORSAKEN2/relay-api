// Development only. Plays fixed caller scenarios against the real model (LLM_PROVIDER in
// .env) and the demo contractor (desert) in the development database, and prints each
// transcript, the tools used, the outcome and the time per reply. For comparing models and
// prompt changes: npm run receptionist:scenarios
//
// It books real jobs (cancelled again at the end) and queues real texts to the scenarios'
// made-up numbers: keep SMS_PROVIDER=log while running it.
import { readFileSync } from 'node:fs'
import { and, eq, inArray } from 'drizzle-orm'
import { env } from '../src/config/env.ts'
import { db, pool } from '../src/db/client.ts'
import { callbackRequests, calls, jobs, tenants } from '../src/db/schema.ts'
import { boss } from '../src/jobs/boss.ts'
import { endCall, handleTurn } from '../src/modules/receptionist/engine.ts'
import { startTestCall } from '../src/modules/receptionist/test-console.service.ts'
import { wrapUpCall } from '../src/modules/receptionist/wrap-up.ts'

type Outcome = 'booked' | 'priority' | 'safety' | 'message' | 'transfer'
type Scenario = { name: string; fromPhone: string; callerLines: string[]; expect: Outcome }

const scenarios: Scenario[] = JSON.parse(
  readFileSync(new URL('./receptionist-scenarios.json', import.meta.url), 'utf8'),
)

const [tenant] = await db.select().from(tenants).where(eq(tenants.slug, 'desert'))
if (!tenant) throw new Error('No demo contractor "desert": run npm run db:seed first')

// Ending a call queues its wrap-up, so the job queue must be up.
await boss.start()
await boss.createQueue('call-wrapup')

const summary: string[] = []
const bookedJobIds: string[] = []

for (const [index, scenario] of scenarios.entries()) {
  console.log(`\n=== ${index + 1}. ${scenario.name}`)
  const { callId, say } = await startTestCall(tenant.id, scenario.fromPhone)
  console.log(`AI: ${say}`)

  const seconds: number[] = []
  for (const line of scenario.callerLines) {
    console.log(`Caller: ${line}`)
    const started = Date.now()
    const reply = await handleTurn(callId, line)
    seconds.push((Date.now() - started) / 1000)
    for (const event of reply.events) {
      console.log(
        event.type === 'safety'
          ? '  [safety script]'
          : `  [${event.name}${event.ok ? '' : ' REFUSED'}] ${event.summary}`,
      )
    }
    console.log(`AI: ${reply.say}`)
    if (reply.action) {
      console.log(`  [call ends: ${JSON.stringify(reply.action)}]`)
      break
    }
  }
  await endCall(callId)
  // Wrapped up here, not by the queue, so the summary prints with its call.
  await wrapUpCall(tenant.id, callId)
  const [ended] = await db
    .select({ summary: calls.summary })
    .from(calls)
    .where(eq(calls.id, callId))
  console.log(`Summary: ${ended.summary}`)
  console.log()

  const outcomes = await outcomesOf(tenant.id, callId)
  const average = seconds.reduce((sum, value) => sum + value, 0) / seconds.length
  const passed = outcomes.includes(scenario.expect)
  summary.push(
    `${passed ? 'PASS' : 'FAIL'}  ${index + 1}. ${scenario.name}: expected ${scenario.expect}, got ${outcomes.join(', ') || 'nothing'} (${average.toFixed(1)} s per reply)`,
  )
}

// Test bookings come off the board again. Done in SQL: there is no signed-in user to
// cancel them through dispatch, and closed jobs must have their links cleared.
if (bookedJobIds.length > 0) {
  await db
    .update(jobs)
    .set({ status: 'cancelled', techLinkHash: null, manageLinkHash: null })
    .where(and(eq(jobs.tenantId, tenant.id), inArray(jobs.id, bookedJobIds)))
}

console.log(`\n=== Summary (LLM_PROVIDER=${env.LLM_PROVIDER})`)
for (const line of summary) console.log(line)
await boss.stop()
await pool.end()

// What the call ended up doing, read back from the database.
async function outcomesOf(tenantId: string, callId: string): Promise<Outcome[]> {
  const [call] = await db.select().from(calls).where(eq(calls.id, callId))
  const booked = await db
    .select({ id: jobs.id, priority: jobs.priority })
    .from(jobs)
    .where(and(eq(jobs.tenantId, tenantId), eq(jobs.callId, callId)))
  const messages = await db
    .select({ id: callbackRequests.id })
    .from(callbackRequests)
    .where(and(eq(callbackRequests.tenantId, tenantId), eq(callbackRequests.callId, callId)))

  bookedJobIds.push(...booked.map((job) => job.id))
  const outcomes: Outcome[] = []
  if (booked.length > 0) outcomes.push('booked')
  if (booked.some((job) => job.priority)) outcomes.push('priority')
  if (call.safetyFlag) outcomes.push('safety')
  if (messages.length > 0) outcomes.push('message')
  if (call.transferredAt && !call.safetyFlag) outcomes.push('transfer')
  return outcomes
}
