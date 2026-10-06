# Receptionist test console

Date: 2026-10-06. Status: proposed. Plan: `docs/superpowers/plans/2026-10-06-receptionist-test-console.md`.
Depends on: `specs/2026-10-06-receptionist-engine-design.md`.
Roadmap: `specs/2026-10-06-mvp-remaining-work.md` (step 6).

## Problem

The engine has no phone yet. To tune the prompt, compare Groq with Haiku and show the
receptionist to a pilot shop, we need to "call" it from a browser: type (or speak) as the
caller, read (or hear) the replies, and see what it did.

## Goal

1. A staff page where the owner or office starts a pretend call, talks to the receptionist and
   hangs up.
2. Optional voice: the browser's own speech recognition and speech voice, so it feels like a
   call. Typing always works.
3. The page shows each action: priority flagged, window offered, booked (with a link to the
   job), message taken, transfer to which number, safety script.
4. A script that runs fixed caller scenarios against the real model and prints the transcripts,
   for comparing models and prompt changes.

## Out of scope

- Audio quality, interruptions, latency of a real phone line. The Twilio spec covers those.
- Saving test transcripts separately: test calls are ordinary `calls` rows (and get wrap-up like
  any call).

## Decisions

### Off unless switched on

`RECEPTIONIST_TEST_CONSOLE=true` turns the API routes on. Off (the default) they answer 404.
Turn it on in development, and in production only for a demo.

**Test bookings are real jobs** with `source = 'ai'`: they show on the board, text the caller
(if consent was given), and count as recovered jobs for the per-job fee. Cancel them after a
demo. Making a fake kind of booking would mean the console tests a different path than real
calls.

### Test calls look like phone calls

`providerSid = 'test-<uuid>'`, `toPhone` = the contractor's active number or `contact_phone`,
`fromPhone` = the number typed on the page (default: the signed-in user's mobile number, so the
returning-caller greeting can be tried with a known customer's number).

### Browser voice, feature-detected

`SpeechRecognition` / `webkitSpeechRecognition` (Chrome, Edge) for the caller's words, one
utterance per press of a "Hold to talk" button; `speechSynthesis` speaks each reply. Where the
browser has neither, the voice toggle is hidden. No audio leaves the browser except through the
browser's own recognition service.

## API

All: signed-in owner or office, the user's own contractor, only when the setting is on.

| Route | Body | Answer |
|---|---|---|
| `POST /api/receptionist/test-calls` | `{ fromPhone? }` | `{ callId, say }` |
| `POST /api/receptionist/test-calls/:callId/turns` | `{ text }` (1–1000 chars) | `{ say, action, events }` |
| `POST /api/receptionist/test-calls/:callId/end` | — | `204` |

`events`: what happened in this turn, for the page only: `{ type: 'tool', name, ok, summary }`
per tool call (e.g. `book_visit ok "Booked Tue Jan 8, 8–10 AM"`), and `{ type: 'safety' }`. The
engine already knows these; `handleTurn` returns them in a field the phone line ignores.

A call id from another contractor, or a call that already ended, answers 404.

## Screen

Route `/receptionist-test`, not in the sidebar (reached from a link in Booking settings when
the API says the console is on, or typed directly).

- Top: caller phone field, Start call / Hang up, voice toggle.
- Middle: the conversation as bubbles (caller right, AI left), with action chips between them
  ("Priority flagged", "Booked → open job", "Transfer to (602) 555-0100", "Message saved",
  "Safety script").
- Bottom: text box + Send (Enter), or "Hold to talk" in voice mode.
- After a transfer or hang-up action the call ends and the page says why.

## Scenario script

`npm run receptionist:scenarios` (dev only, `scripts/receptionist-scenarios.ts`): runs each
scenario in `scripts/receptionist-scenarios.json` against the configured `LLM_PROVIDER` and the
demo contractor in the dev database, prints each transcript, the tools called, the outcome and
the time per reply, and a one-line summary per scenario. Scenarios:

1. AC not cooling, books the first window, says yes to texts.
2. No heat, 90-year-old mother at home → priority, earliest window.
3. "I smell gas in the kitchen" → safety, no booking.
4. ZIP outside the area → message taken.
5. "Can I talk to a real person?" → transfer.
6. Wants a price for a new system → no price, message taken.
7. Caller changes their mind about the window, then books.
8. Says no to texts → booked, no confirmation text.

Bookings it makes are cancelled at the end of the run.

## Testing

- `receptionist.routes.test.ts`: setting off → 404; office of another contractor → 404 on the
  call; full start / turn / end with a mocked `chat()`; turn after end → 404.
- `relay-web`: `speech.ts` feature detection and the chip text helper unit tested; the page
  checked by hand in headless Edge (typing; voice can't be tested headless).
