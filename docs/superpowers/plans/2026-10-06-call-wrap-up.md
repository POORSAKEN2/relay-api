# Call Wrap-Up Implementation Plan

**Goal:** Every AI call ends with its transcript saved, a short summary on the call and on the
booked job's notes, and a `call.handled` event. Idle calls are ended automatically.

**Architecture:** `endCall` saves the transcript and queues the pg-boss job `call-wrapup`; the
job writes the summary (model, or a plain fallback) and the note. A one-minute sweep ends idle
sessions. No schema change.

**Spec:** `relay-api/docs/superpowers/specs/2026-10-06-call-wrap-up-design.md`

## Global Constraints

- Branch `feat/call-wrap-up` in `relay-api` and `relay-web`, after the engine.
- Lean, plain code a junior developer can debug without AI.
- Commit messages lowercase conventional. No `Co-Authored-By` trailer.
- Biome only on touched files.

## Task 1: transcript at the end of the call

- [ ] `receptionist/transcript.ts` + test: `formatTranscript(turns)`.
- [ ] `engine.ts → endCall`: update the call (`endedAt`, `transcript`), then
      `await queueJob('call-wrapup', { tenantId, callId })`, then delete the session.
      `jobs/index.ts` exports a small `queueJob(name, data)` around `boss.send` (the file only
      schedules crons today).
- [ ] Commit `feat: save the transcript when an ai call ends`.

## Task 2: the wrap-up job

- [ ] `receptionist/wrap-up.ts`:
      ```ts
      // After an AI call: a summary for the office, on the call and on the job it booked.
      // Runs in a job so the caller's hang-up isn't held up by the model.
      export async function wrapUpCall(tenantId: string, callId: string) {
        const call = await queries.findCallToWrapUp(tenantId, callId)
        if (!call || call.summary) return // gone, or already done (a retried job)
        const summary = (await summarize(call.transcript)) ?? plainSummary(call)
        const jobId = await db.transaction(async (tx) => {
          await queries.updateCall(tenantId, callId, { summary }, tx)
          if (!call.jobId) return null
          await insertNote(tenantId, { jobId: call.jobId, authorId: null, body: `Call summary (AI): ${summary}` }, tx)
          return call.jobId
        })
        if (jobId) emitToTenant(tenantId, 'job.note_added', { jobId, dates: [call.jobDate] })
        emitToTenant(tenantId, 'call.handled', { callId })
      }
      ```
      `summarize` returns null on `LlmUnavailable`. `plainSummary` + test.
- [ ] `dispatch.queries.ts → insertNote`: `authorId: string | null`.
- [ ] `jobs/index.ts`: `register('call-wrapup', {}, ({ tenantId, callId }) => wrapUpCall(tenantId, callId))`.
- [ ] `realtime/events.ts`: `'call.handled': { callId: string }`.
- [ ] `wrap-up.test.ts` (spec's list).
- [ ] Commit `feat: ai call summary on the call and the job notes`.

## Task 3: idle sweep

- [ ] `receptionist/session.ts`: `endIdleSessions(now)` ends sessions with `lastActivity` older
      than 10 minutes (through `endCall`). `startSessionSweep()` / `stopSessionSweep()` with a
      60-second `setInterval`, started and stopped in `server.ts` next to the sender loop.
- [ ] Test with fake timers.
- [ ] Commit `feat: end receptionist calls nobody hung up`.

## Task 4: relay-web

- [ ] `src/lib/socket.ts`: `'call.handled': { callId: string }`.
- [ ] Analytics hooks invalidate on `call.handled`.
- [ ] Job notes with `authorName: null` show "AI receptionist" (dispatch job drawer, technician
      job page). Make the zod schema allow `null`.
- [ ] Commit `feat: show ai call summaries in job notes`.
