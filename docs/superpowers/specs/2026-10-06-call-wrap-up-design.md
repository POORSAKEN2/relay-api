# Call wrap-up

Date: 2026-10-06. Status: proposed. Plan: `docs/superpowers/plans/2026-10-06-call-wrap-up.md`.
Depends on: `specs/2026-10-06-receptionist-engine-design.md`.
Roadmap: `specs/2026-10-06-mvp-remaining-work.md` (step 7).

## Problem

MVP module 4: "Call recording and transcript." The tech stack doc's `call-wrapup` job: "Saves
the transcript and recording, adds an AI summary to the job notes." Realtime `call.handled`:
"The AI or text-back handles a call → updates the recovered-revenue numbers."

The engine keeps every turn of a call in memory and forgets it at `endCall`. Nothing is saved.

## Goal

1. When an AI call ends, its transcript is saved in `calls.transcript`.
2. A short summary is saved in `calls.summary` and, when the call booked a job, added to the
   job's notes, where the office and the technician already read notes.
3. The dashboard hears `call.handled`.
4. A call whose caller just disappears (no hang-up event) is still wrapped up.

## Out of scope

- The recording audio: Twilio phone line spec (`calls.recording_key`).
- A call log screen. Roadmap item after the receptionist.
- Transcribing audio with Whisper. The transcript is built from the text turns the engine
  already has (ConversationRelay gives us the caller's words as text), so no second
  transcription is needed.

## Design

### Two steps: save now, summarize later

`endCall(callId)`:

1. In one statement: `ended_at = now()`, `transcript = formatTranscript(session.turns)`.
2. Queue the pg-boss job `call-wrapup` with `{ tenantId, callId }`.
3. Forget the session.

The job (`receptionist/wrap-up.ts → wrapUpCall`):

1. Load the call (transcript, safety flag, priority, transferred) and its job, if any
   (`jobs.call_id = call.id`).
2. Ask the model for the summary (below). If the model fails, build a plain one from the facts
   instead: "AI call. Booked Tue Jan 8, 8–10 AM." / "AI call. Message taken." / "AI call.
   Safety script (gas or CO)." / "AI call. Transferred to staff."
3. Save `calls.summary`. When there is a job: insert a `job_notes` row with `author_id = null`
   (the column comment already says "null = AI call summary"), body
   `Call summary (AI): <summary>`, and emit `job.note_added`.
4. Emit `call.handled` `{ callId }`.

Steps 3 and 4 run only if `calls.summary` is still null, so a retried job doesn't add the note
twice.

Hanging up stays fast for the caller: the slow model call happens in the job.

### Transcript format

```
AI: Thanks for calling Desert Breeze Air. I'm … How can I help you today?
Caller: My AC stopped blowing cold air.
AI: Sorry to hear that. What's the ZIP code there?
```

Plain text, one line per turn, kept as said. Tool calls are not in the transcript (they are in
the logs and the audit log).

### Summary prompt

System: "Summarize this phone call for an HVAC office in at most three short sentences: what
the caller needed, what was done (booked, message taken, transferred, safety script), and
anything the office or technician must follow up on. Plain text, no greeting." User: the
transcript. `maxTokens` 200.

### Calls nobody ends

A phone call that drops without a close event, or a test-console tab that is just closed,
would keep its session forever. A sweep every minute (`setInterval` started with the server,
like the sender loop) ends sessions with no activity for 10 minutes through the same `endCall`.

## Realtime

`call.handled` `{ callId }` added to `realtime/events.ts` and `relay-web/src/lib/socket.ts`.
The analytics page invalidates its queries on it.

## Screen (`relay-web`)

Job notes with no author show "AI receptionist" as the author name (job drawer and technician
job page), instead of an empty name.

## Testing

- `wrap-up.test.ts` (test DB, `chat()` mocked):
  - booked call: transcript saved at `endCall`, job queued; `wrapUpCall` saves the summary,
    one note with `author_id null`, emits `job.note_added` and `call.handled`;
  - model fails: the plain summary is saved;
  - run twice: one note;
  - call with no job: summary saved, no note.
- `formatTranscript` unit test.
- Sweep: a session idle 11 minutes is ended; one idle 5 minutes is kept (fake timers).
