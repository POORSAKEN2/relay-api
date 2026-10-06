# Receptionist Test Console Implementation Plan

**Goal:** Owner or office can call the AI receptionist from a browser page (typing, or the
browser's own voice) and see every action it takes. A scenario script compares models.

**Architecture:** Three dev routes in `receptionist.routes.ts`, gated by
`RECEPTIONIST_TEST_CONSOLE`. `handleTurn` also returns `events` for the page. A
`/receptionist-test` page in `relay-web`. A scenario runner in `relay-api/scripts/`.

**Spec:** `relay-api/docs/superpowers/specs/2026-10-06-receptionist-test-console-design.md`

## Global Constraints

- Branch `feat/receptionist-test-console` in `relay-api` and `relay-web`, after the engine.
- Lean, plain code a junior developer can debug without AI.
- Commit messages lowercase conventional. No `Co-Authored-By` trailer.
- Biome only on touched files.

## Task 1: routes (relay-api)

- [ ] `env.ts`: `RECEPTIONIST_TEST_CONSOLE: z.stringbool().default(false)` (or the boolean
      pattern the file already uses).
- [ ] `engine.ts`: `handleTurn` also returns `events: TurnEvent[]` (collected in `runTool` and
      the safety path). `startCall` accepts the test `providerSid`.
- [ ] `receptionist.schemas.ts`: `StartInput { fromPhone: Phone.optional() }`,
      `TurnInput { text: string().trim().min(1).max(1000) }`, `CallParams { callId: z.uuid() }`.
- [ ] `receptionist.routes.ts`:
      ```ts
      // A pretend phone call from a browser, to try the receptionist before a phone line
      // exists. Off unless RECEPTIONIST_TEST_CONSOLE=true: its bookings are real jobs.
      const consoleOn: RequestHandler = (_req, _res, next) =>
        env.RECEPTIONIST_TEST_CONSOLE ? next() : next(new HttpError(404, 'not_found', 'Route not found'))
      ```
      Start: `startCall(tenantOf(user), { providerSid: \`test-${randomUUID()}\`, fromPhone, toPhone })`.
      Turn and end: check the session's tenant is the user's (else 404).
      Mount in `app.ts`.
- [ ] `receptionist.routes.test.ts` (spec's list, `chat()` mocked).
- [ ] Commit `feat: test console routes for the receptionist`.

## Task 2: the page (relay-web)

- [ ] `src/features/receptionist/api.ts`: `useStartCall`, `useSendTurn`, `useEndCall`.
- [ ] `src/features/receptionist/speech.ts` (+ test): `speechSupport()` →
      `{ listen: boolean, speak: boolean }`; `listenOnce(): Promise<string>` wrapping
      `webkitSpeechRecognition` (`lang 'en-US'`, `interimResults false`); `speak(text)` with
      `speechSynthesis`, cancelling anything still speaking.
- [ ] `src/features/receptionist/chips.ts` (+ test): event → chip label and link.
- [ ] `src/routes/receptionist-test.tsx`: the layout in the spec. Conversation state lives in a
      `useState` array of `{ speaker, text } | { chip }`.
- [ ] `router.tsx`: staff route `/receptionist-test`. Booking settings page: a "Try the AI
      receptionist" link when `POST /receptionist/test-calls` is available (simplest: a `GET
      /api/receptionist/test-console` that answers `{ on: boolean }`, add it in Task 1).
- [ ] Check in headless Edge: start, type a full booking (with a real `LLM_PROVIDER`), see the
      chips and the job on the board.
- [ ] Commit `feat: page to try the ai receptionist from the browser`.

## Task 3: scenario runner (relay-api, dev only)

- [ ] `scripts/receptionist-scenarios.json`: the 8 scenarios from the spec, each
      `{ name, fromPhone, callerLines: string[], expect: 'booked' | 'priority' | 'safety' |
      'message' | 'transfer' }`.
- [ ] `scripts/receptionist-scenarios.ts`: for each scenario, `startCall` on the demo contractor
      (`desert`), feed the lines one by one (stop early on an action), `endCall`, print the
      transcript, tools, outcome vs `expect`, and seconds per reply; at the end cancel the jobs
      it booked. `package.json`: `"receptionist:scenarios": "node --env-file-if-exists=.env scripts/receptionist-scenarios.ts"`.
- [ ] Run it once with Groq and once with Haiku; paste the summary lines into the PR.
- [ ] Commit `feat: scenario runner to compare receptionist models`.
