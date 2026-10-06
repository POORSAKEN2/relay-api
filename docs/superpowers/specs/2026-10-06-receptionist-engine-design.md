# Receptionist engine

Date: 2026-10-06. Status: proposed. Plan: `docs/superpowers/plans/2026-10-06-receptionist-engine.md`.
Depends on: `specs/2026-10-06-llm-client-design.md`. Used by: the test console now, the Twilio
phone line later. Roadmap: `specs/2026-10-06-mvp-remaining-work.md` (step 5).

## Problem

MVP module 4: the AI receptionist "answers overflow and after-hours calls in the company's name;
collects the problem, address and contact details, then books a time window; triage: no heat or
no cooling with an elderly or infant occupant gets a priority flag; gas smell: safety script
only, no booking; transfers to a person or on-call number when needed; call recording and
transcript, with disclosure."

This spec is the brain only: text in, text out. No phone, no audio. The phone line
(ConversationRelay) will send the caller's words as text and speak the engine's replies.

## Goal

1. `startCall()` saves the call as answered by the AI with the disclosure time, and returns the
   greeting, which always says it is an AI and the call is recorded.
2. `handleTurn()` takes what the caller said and returns what to say, plus an action
   (transfer, hang up) when there is one.
3. The AI books through the **same booking code as the web form**, with `source = 'ai'` and the
   call linked.
4. Gas or CO never gets a booking: the backend checks every caller turn **before** the model
   sees it, and the booking tool refuses on a flagged call, whatever the model says.
5. A vulnerable person with no heat or cooling makes the job PRIORITY.
6. The caller can ask for a person at any time.
7. When the model fails, the caller is never left in silence: the engine takes a message.

## Out of scope

- Audio, phone numbers, recording: the Twilio phone line spec.
- Transcript, summary and job note after the call: the call wrap-up spec. This spec keeps the
  turns in memory so wrap-up can save them.
- Card links (on hold, payments decision 2026-10-03), waitlist by phone, Spanish, outbound calls.
- Rescheduling or cancelling an existing visit by phone. The AI takes a message instead.

## Decisions

### The model talks, the backend decides

The system prompt guides the conversation; every rule that matters is enforced in code:

| Rule | Where it is enforced |
|---|---|
| AI and recording disclosure | `startCall` builds the greeting; `disclosed_at` saved with the call (DB check `calls_ai_disclosed`) |
| Gas / CO → safety script, no booking | keyword check on every caller turn before the model; `book_visit` refuses when `session.safety` |
| Book only open windows, never over the cap | `book_visit` → `reserveWindow(..., { allowOverCap: false })` in a transaction |
| Book only in the service area | `book_visit` re-checks the ZIP |
| Only windows the AI actually offered | `book_visit` takes a window key (`W1`…) from `get_open_windows`, not a raw id |
| Texts need consent | `book_visit` records `call` consent only when the caller said yes; `sendText` checks it |
| No card numbers by voice | no tool accepts card data |

### No hold during the call

Flow B held a window while the caller added a card. With no card step, the caller confirms
within seconds, so the AI books on "yes". If the window filled in those seconds,
`book_visit` answers `window_full` and the AI offers the next one. No hold rows, no expiry job.

### Sessions live in memory

One call is one `CallSession` in a `Map` keyed by call id, in the API process. A phone call
lives on one websocket to one process, and Render runs one instance, so this is enough. If the
process restarts mid-call the call drops anyway. No new table for in-progress calls.

### Numbered choices instead of ids

The model never sees UUIDs. Services are listed as `S1, S2…` in the prompt; `get_open_windows`
returns `W1…W6` with spoken labels ("Tuesday January 8, 8 to 10 AM"). The session maps keys to
real ids. Copying a short key is reliable; copying a UUID is not.

### Business hours for transfers

There is no business-hours table. "During business hours" = today's arrival windows span (from
the first window's start to the last window's end, contractor time zone). During hours, transfer
to `office_phone`, else `on_call_phone`, else the other one; neither set → take a message.

## The flow (one call)

```
startCall ──► greeting + disclosure
   │
   ▼
handleTurn(caller text)
   ├─ gas / CO words? ──yes──► safety script, safety_flag, transfer to on-call (or hang up)
   ├─ session already in safety? ──► repeat the safety script
   └─ model round (up to 4 tool rounds)
         tools: check_service_area · get_open_windows · flag_priority · book_visit
                take_message · transfer_to_human · report_safety_issue
         └─► reply text (+ transfer / hang-up action)
   model fails ──► "I'll have someone call you back", take_message with what we know, hang up
```

## API (TypeScript, used by the test console and later the phone line)

```ts
startCall(tenantId: string, call: { providerSid: string; fromPhone: string | null; toPhone: string })
  : Promise<{ callId: string; say: string }>

handleTurn(callId: string, callerText: string)
  : Promise<{ say: string; action: null | { type: 'transfer'; to: string } | { type: 'hang_up' } }>

endCall(callId: string): Promise<void> // marks ended_at, forgets the session (wrap-up extends it)
```

## Greeting

```
Thanks for calling ${tenant.name}. I'm ${tenant.name}'s virtual assistant. I'm an AI, and this
call is recorded. How can I help you today?
```

Fixed text from code, never from the model. `disclosed_at = now()` is saved in the same insert
as `answered_by = 'ai'`.

## Safety

`mentionsGasOrCo(text)`: lowercase, then match any of: `smell gas`, `smells like gas`, `gas
smell`, `gas leak`, `leaking gas`, `rotten egg`, `carbon monoxide`, `co alarm`, `co detector`,
`co monitor`, `c o alarm`, `c o detector`. Speech-to-text writes "CO" as "co" or "c o". Words
like "gas furnace" or "gas heater" alone don't match.

The model also gets a `report_safety_issue` tool for wording the list misses ("there's a weird
sulfur smell by the water heater"). Both paths run the same code:

```
SAFETY_SCRIPT = "This could be dangerous. Please leave the house now, and once you are outside
call your gas company or 911. Don't use light switches or anything that could make a spark.
I'm connecting you to our on-call technician now."
```

`calls.safety_flag = true`, `session.safety = true`, action transfer to the on-call target (if
none: the script ends with "Please call 911 now" and the action is hang up). Every later turn
gets the script again.

## Tools

All inputs are checked with zod. A failed check or a refused action returns
`{ "error": "<plain sentence for the model>" }`, never throws, so the model can recover.

| Tool | Input | What the backend does |
|---|---|---|
| `check_service_area` | `zip` | `zipIsServed`; saves `session.zip`, `session.served` |
| `get_open_windows` | none | `listOpenWindows` for the next 14 days; the first 6 (priority calls: same list, the prompt says to offer the earliest first); saves `W1…W6` in the session; returns key + spoken label |
| `flag_priority` | `reason` | `session.priority = true`; `calls.priority = true` |
| `book_visit` | `windowKey`, `serviceKey`, `problem`, `systemType`, `vulnerableOccupant`, `name`, `street`, `unit?`, `city`, `state`, `zip`, `phone?`, `textConsent` | refuses when `safety`, unknown keys, or no phone (caller ID hidden and none given); else `bookHomeownerVisit(…, { source: 'ai', callId })`; saves `session.bookedJobId`; returns the spoken summary |
| `take_message` | `name?`, `phone?`, `message` | `callback_requests` row, `source = 'ai'`, `call_id` set |
| `transfer_to_human` | `reason` | picks the target (see Decisions); none → error telling the model to take a message; else action transfer, `calls.transferred_at = now()` |
| `report_safety_issue` | `what` | the safety path above |

`systemType` uses `SYSTEM_TYPES`; the model is told to use `not_sure` when the caller doesn't
know.

### Booking through the web form's code

`online-booking.service.ts → bookVisit` is split: a new exported
`bookHomeownerVisit(tenant, input, origin, tx?)` does the checks, customer, property, job,
consent, confirmation text and audit; `bookVisit` (web) calls it with
`{ source: 'web' | 'text_back', ip, consentSource: 'booking_form' }`, and `book_visit` (AI)
with `{ source: 'ai', callId, consentSource: 'call', consentWording: CALL_CONSENT_QUESTION }`.
One booking path, so the AI can never skip a rule the web form follows.

Consent by phone: the prompt tells the AI to ask, word for word, `CALL_CONSENT_QUESTION =
"Can we text you a confirmation and reminders about this visit? You can reply STOP any time."`
Only a clear yes sets `textConsent: true`, saved as a `consent_events` row (`channel 'sms'`,
`source 'call'`, `call_id`, wording = the question). No yes, no confirmation text (blocked by the
gate), the booking still stands.

Audit: `job.booked` with actor type `ai` (new `insertAiAction` in `audit.queries.ts`).

## System prompt (outline)

Built by a pure function from the tenant, today's date in its time zone, the service list and,
when caller ID matches a customer, their name and saved addresses:

- You answer the phone for {name}, an HVAC company. You already said you are an AI and the call
  is recorded; never deny being an AI.
- Your replies are spoken: one or two short sentences, one question at a time, no lists, no
  symbols, say times like "8 to 10 in the morning".
- Collect, in this order: the problem; whether anyone at home is elderly, an infant, or
  medically fragile when there is no heat or cooling; ZIP code (check it); arrival window;
  service; system type; name; street address, city and state; then read the booking back and
  ask "Should I book that?" Ask the consent question word for word before booking.
- Returning caller: "Is this about {address}?" instead of asking for the address.
- Never quote repair prices. You may say the diagnostic fee of the chosen service.
- Never diagnose, never promise an exact arrival time, never take card numbers.
- Outside the service area, or the caller wants something you can't do (reschedule, a quote,
  a complaint): take a message.
- The caller asks for a person: use `transfer_to_human`.
- Gas, burning or rotten-egg smells, CO alarms: use `report_safety_issue` at once.

## Edge cases

| Case | Result |
|---|---|
| "I smell gas" in the first sentence | safety script, no model call, transfer to on-call |
| "My gas furnace won't start" | normal call |
| Gas mentioned after a window was offered | safety path; `book_visit` refuses from then on |
| Model calls `book_visit` with `W9` | error "Offer windows from get_open_windows first" |
| Window filled during the call | error `window_full` sentence; model offers another |
| ZIP outside the area | model takes a message |
| Caller ID hidden, no phone given | `book_visit` error asks the model to get a phone number |
| Caller says no to texts | booked, consent not recorded, confirmation text blocked |
| Model times out | apology, `take_message` with the transcript so far, hang up |
| No `office_phone` nor `on_call_phone` | transfer tool errors; model takes a message |
| Same caller books twice in one call | second `book_visit` refused ("Already booked this call") |
| 4 tool rounds without a reply | "Let me have someone call you back", take a message, hang up |

## Testing

All with a mocked `chat()` (`vi.mock('../llm/llm.ts')`) returning scripted replies, against the
test database (`createShop`):

- `safety.test.ts`: positive and negative phrases.
- `transfer.test.ts`: `transferTarget()` during hours, after hours, only one number set, none.
- `prompt.test.ts`: the prompt names the contractor, lists `S1…`, includes the returning
  caller's address, and never contains a UUID.
- `engine.test.ts`:
  - `startCall` saves `answered_by = 'ai'`, `disclosed_at`, matched `customer_id`; greeting says
    "AI" and "recorded";
  - a full booking script: ZIP → windows → `book_visit` → job `source 'ai'`, `call_id`, priority
    when flagged, consent row `source 'call'`, confirmation text queued;
  - gas in the first turn: no `chat()` call, `safety_flag`, transfer action;
  - `book_visit` after safety, with an unknown key, twice: refused;
  - `chat()` throws `LlmUnavailable`: callback request saved, hang-up action;
  - `transfer_to_human`: `transferred_at` set, action carries the number.
- `online-booking.test.ts` keeps passing unchanged after the `bookHomeownerVisit` split.
