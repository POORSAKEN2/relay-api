# Receptionist Engine Implementation Plan

**Goal:** A text-in, text-out AI receptionist: `startCall`, `handleTurn`, `endCall`. It
discloses, triages, books through the web form's code with `source = 'ai'`, takes messages and
decides transfers. No phone yet.

**Architecture:** New `src/modules/receptionist/`. Small pure files (safety words, transfer
target, prompt) with unit tests; `tools.ts` (zod-checked handlers over existing services);
`engine.ts` (in-memory sessions, the model loop, fallbacks). Booking reuses a new
`bookHomeownerVisit()` split out of `online-booking.service.ts`.

```
receptionist/engine ─► llm/llm.ts
        ├► receptionist/tools ─► online-booking.service  bookHomeownerVisit, checkZip, listOpenWindows
        │                     ├► online-booking.queries  insertCallback
        │                     └► receptionist/transfer
        ├► receptionist/prompt, safety
        └► receptionist/receptionist.queries  (calls rows)
```

Nothing imports `receptionist`; it imports outward only.

**Spec:** `relay-api/docs/superpowers/specs/2026-10-06-receptionist-engine-design.md`

## Global Constraints

- Branch `feat/receptionist-engine` in `relay-api`, from `main`, after the LLM client is merged.
- Lean, plain code a junior developer can debug without AI. Short "why" comments.
- Commit messages lowercase conventional. No `Co-Authored-By` trailer.
- Biome only on touched files. Tests mock `chat()`; none call a real model.

## Task 1: one booking path for web and AI

- [ ] `online-booking.service.ts`: move the body of `bookVisit` into
      ```ts
      // Every homeowner booking (web form, missed-call link, AI on the phone) goes through here,
      // so all of them follow the same checks and send the same texts.
      export async function bookHomeownerVisit(
        tenant: Tenant,
        input: BookingInput,
        origin: {
          source: 'web' | 'text_back' | 'ai'
          callId?: string
          ip: string | null
          // null: no consent to record (box unticked, or the caller said no to texts)
          consent: { source: 'booking_form' | 'call'; wording: string } | null
        },
      ): Promise<{ jobId: string; date: string; windowLabel: string }>
      ```
      `bookVisit(tenant, input, ip)` becomes the web wrapper (it decides `web` / `text_back` as in
      the text-back plan, then calls `bookHomeownerVisit`). `recordConsent` takes the consent
      source, wording and `callId`. The audit row uses `insertAiAction` when `source === 'ai'`.
- [ ] `audit.queries.ts`: `insertAiAction(tenantId, event, tx)` (actor type `ai`, no user).
- [ ] `online-booking.test.ts` passes unchanged; add one test calling `bookHomeownerVisit` with
      `source 'ai'` and a call id.
- [ ] Commit `refactor: one homeowner booking path for web and phone`.

## Task 2: pure pieces

- [ ] `receptionist/safety.ts` + test: `SAFETY_PHRASES`, `mentionsGasOrCo(text)`,
      `SAFETY_SCRIPT`, `SAFETY_SCRIPT_NO_TRANSFER`.
- [ ] `receptionist/transfer.ts` + test:
      ```ts
      // Who takes a call the AI hands over. "Business hours" are today's arrival windows,
      // from the first start to the last end, in the contractor's time zone.
      export function transferTarget(
        phones: { officePhone: string | null; onCallPhone: string | null },
        todaysWindows: { startsAt: string; endsAt: string }[], // '08:00:00'
        localTime: string, // '14:05:00'
      ): string | null
      ```
- [ ] `receptionist/prompt.ts` + test: `GREETING(name)`, `CALL_CONSENT_QUESTION`,
      `buildSystemPrompt({ tenantName, today, services: [{ key, name, feeLabel }], caller:
      { name, addresses } | null })`.
- [ ] Commit `feat: receptionist safety words, transfer target and prompt`.

## Task 3: call rows and the session

- [ ] `receptionist/receptionist.queries.ts`: `insertAiCall(tenantId, values)` (with
      `answeredBy: 'ai'`, `disclosedAt: new Date()`), `updateCall(tenantId, callId, change)`,
      `findCallerContext(tenantId, phone)` (customer name + saved addresses), `findTenantPhones`,
      `listWindowsToday(tenantId)`.
- [ ] `receptionist/session.ts`:
      ```ts
      export type CallSession = {
        callId: string
        tenant: Tenant
        fromPhone: string | null
        messages: ChatMessage[] // what the model has seen
        turns: { speaker: 'caller' | 'ai'; text: string; at: Date }[] // for the transcript
        services: Map<string, string> // 'S1' → service id
        windows: Map<string, { windowId: string; date: string; label: string }> // 'W1' → …
        zip: string | null
        priority: boolean
        safety: boolean
        bookedJobId: string | null
        lastActivity: Date
      }
      const sessions = new Map<string, CallSession>()
      export function getSession(callId: string) { … } // throws a 404 HttpError when unknown
      ```

## Task 4: tools

- [ ] `receptionist/tools.ts`: `TOOL_SPECS: ToolSpec[]` (JSON Schema per tool, short
      descriptions written for the model) and
      `runTool(session, call: ToolCall): Promise<{ output: string; action?: Action }>`.
      One small function per tool; each parses its input with zod and returns
      `JSON.stringify({ … })` or `JSON.stringify({ error: '…' })`. `book_visit` maps keys to ids,
      builds a `BookingInput` and calls `bookHomeownerVisit(…, { source: 'ai', callId, ip: null,
      consent: textConsent ? { source: 'call', wording: CALL_CONSENT_QUESTION } : null })`. `HttpError` from booking (`window_full`, `outside_area`, …) becomes
      `{ error: error.message }`.
- [ ] Commit `feat: receptionist tools over the booking services`.

## Task 5: the engine

- [ ] `receptionist/engine.ts`:
      ```ts
      const MAX_TOOL_ROUNDS = 4

      export async function handleTurn(callId: string, callerText: string) {
        const session = getSession(callId)
        addTurn(session, 'caller', callerText)

        // Checked before the model sees the words, so no reply can talk past a gas leak.
        if (session.safety || mentionsGasOrCo(callerText)) return say(session, await safetyPath(session))

        session.messages.push({ role: 'user', text: callerText })
        try {
          for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
            const reply = await chat({ system: session.system, messages: session.messages, tools: TOOL_SPECS })
            session.messages.push({ role: 'assistant', text: reply.text, toolCalls: reply.toolCalls })
            if (reply.toolCalls.length === 0) return say(session, { text: reply.text, action: null })

            const results = []
            let action: Action | null = null
            for (const call of reply.toolCalls) {
              const result = await runTool(session, call)
              results.push({ toolCallId: call.id, name: call.name, output: result.output })
              action ??= result.action ?? null
            }
            session.messages.push({ role: 'tool', results })
            // A safety or transfer tool ends the conversation: say the fixed line, no more model.
            if (action) return say(session, { text: actionLine(session, action), action })
          }
          return say(session, await giveUp(session, 'too many tool rounds'))
        } catch (error) {
          if (!(error instanceof LlmUnavailable)) throw error
          return say(session, await giveUp(session, error.message))
        }
      }
      ```
      `giveUp` saves a `take_message` callback with the caller's words so far and returns the
      apology with a hang-up action. `startCall` builds the session and inserts the call;
      `endCall` sets `ended_at` and deletes the session.
- [ ] `engine.test.ts` with `vi.mock('../llm/llm.ts')`: the spec's Testing list.
- [ ] Commit `feat: receptionist engine answers, books and hands over calls`.
