# Twilio phone line

Date: 2026-10-06. Status: proposed, **blocked until a Twilio account with a US number exists**.
Plan: `docs/superpowers/plans/2026-10-06-twilio-phone-line.md`.
Depends on: receptionist engine, call wrap-up, missed-call text-back.
Roadmap: `specs/2026-10-06-mvp-remaining-work.md` (step 8).

## Problem

The receptionist works in a browser. Homeowners call a phone number. Flow B: the office answers
when it can; when staff are busy or it is after hours, the AI answers in the company's name; a
caller who hangs up while it rings gets the text-back; a caller who asks for a person is
transferred live; calls are recorded.

Decision (2026-10-06): Twilio for calls **and** texts, replacing Telnyx (calls) and, for pilots,
httpSMS (texts).

Twilio details below (TwiML verbs, ConversationRelay message names, callback fields) are from
memory of Twilio's docs; **check each against the current Twilio docs while building**.

## Goal

1. A call to the contractor's Twilio number rings the office for `office_ring_seconds` during
   business hours, then the AI answers. After hours the AI answers at once.
2. The AI conversation runs through ConversationRelay: Twilio turns speech into text, the
   engine answers, Twilio speaks the reply.
3. A transfer bridges the caller to the target number.
4. A caller who hangs up before anyone (office or AI) answers is a missed call and gets the
   text-back.
5. AI calls are recorded; `calls.recording_key` points at the recording.
6. Texts go out and come in through Twilio (`SMS_PROVIDER=twilio`).
7. Telnyx code and settings are removed.

## Out of scope

- Number porting and 10DLC registration screens: done by hand in the Twilio console for the
  pilots; `tenants.texting_status` is set by the superadmin.
- Twilio subaccounts per contractor. One account, numbers listed in `phone_numbers`.
- Moving recordings into our own storage. Later, when file storage is decided.
- Spanish voice.

## Design

### Webhooks and the voice websocket

```
Twilio ──POST /api/webhooks/twilio/voice ───────────► voice: ring office or start AI
       ──POST /api/webhooks/twilio/voice/dial-ended ─► office didn't answer: start AI
       ──POST /api/webhooks/twilio/voice/ai-ended ──► AI handed off: <Dial> the transfer
       ──POST /api/webhooks/twilio/voice/status ────► call finished: missed? text-back
       ──POST /api/webhooks/twilio/recording ───────► recording ready: save its SID
       ──POST /api/webhooks/twilio/sms ─────────────► text received (inbox, STOP / START)
       ──POST /api/webhooks/twilio/sms-status ──────► sent / delivered / failed
       ══ wss /voice/relay ═════════════════════════► ConversationRelay ⇄ receptionist engine
```

Every webhook checks `X-Twilio-Signature` with the `twilio` package's `validateRequest` against
`PUBLIC_API_URL + req.originalUrl` and the form body, and records its event id in
`webhook_events` (provider `twilio` already allowed) so a retry does nothing twice.

### Answering

`/voice` (incoming call): find the contractor by `To` (`phone_numbers`), insert a `calls` row
(`provider_sid = CallSid`, `answered_by = null`). Then:

- business hours (the transfer spec's rule) and `office_phone` set → TwiML
  `<Dial timeout="{office_ring_seconds}" action="/voice/dial-ended">{office_phone}</Dial>`;
- else → the AI TwiML.

`/voice/dial-ended`: `DialCallStatus = completed` → `answered_by = 'office'`, `<Hangup/>`;
`no-answer`, `busy`, `failed` → the AI TwiML.

AI TwiML:

```xml
<Response>
  <Connect action="/api/webhooks/twilio/voice/ai-ended">
    <ConversationRelay url="wss://api.garified.com/voice/relay" welcomeGreeting="{greeting}" />
  </Connect>
</Response>
```

The greeting is the engine's fixed greeting (with the AI and recording disclosure).

### ConversationRelay ⇄ engine

A `ws` server on the same HTTP server, path `/voice/relay` (Socket.IO keeps `/socket.io`).

| Twilio sends | Relay does |
|---|---|
| `setup` (`callSid`, `from`, `to`) | find the call by `callSid`; `startCall` for it: `answered_by = 'ai'`, `disclosed_at = now()` (the greeting is playing); start the recording |
| `prompt` (`voicePrompt`, `last: true`) | `handleTurn(callId, voicePrompt)`, send `{ type: 'text', token: say, last: true }`; on a transfer action also send `{ type: 'end', handoffData: '{"transferTo":"+1…"}' }`; on hang up, `{ type: 'end' }` |
| `interrupt` | ignored for now (whole replies are short) |
| `error` | logged to Sentry |
| socket closes | `endCall(callId)` |

`startCall` is split so the phone line can turn an existing missed-looking row into an AI call
(`answerWithAi(callId)`), rather than inserting a second row.

`/voice/ai-ended`: `HandoffData.transferTo` present → `<Dial>{transferTo}</Dial>` (the AI already
said "connecting you now"); else `<Hangup/>`.

### Missed calls

`/voice/status` with `CallStatus = completed` (or `no-answer`, `busy`, `canceled`): set
`ended_at`; if the row still has `answered_by = null`, nobody picked up → `textBackMissedCall`
(the same core function httpSMS uses). An AI call is never missed.

### Recording

At `setup`, start a recording of the call through Twilio's REST API with a
`recordingStatusCallback` to `/recording`. When it is `completed`, save the **recording SID** in
`calls.recording_key`. Audio stays on Twilio for now; playing it back later goes through an
owner-only API route that streams it from Twilio. Moving files to Supabase Storage or R2 is a
later task.

### Texts through Twilio

`SMS_PROVIDER = 'twilio'`: `messaging/twilio-sms.ts` next to `httpsms.ts` with the same
`sendSms({ from, to, body, messageId })` shape, sending from the contractor's number (or its
`messaging_service_sid` once 10DLC is approved) with a `StatusCallback` to `/sms-status`.
`/sms` maps the inbound form fields to the same `receiveText` core (STOP / START, inbox); the
webhook service is split so httpSMS and Twilio both call `receiveText(tenantId, { contact, body,
providerMessageId })` and `updateTextStatus`. Twilio also handles STOP itself at the carrier;
Relay's own consent record stays the source of truth.

### Settings

`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `PUBLIC_API_URL` (the address Twilio calls, needed for
the signature check behind Render's proxy). `SMS_PROVIDER` gains `twilio`. `TELNYX_*` removed.

## Edge cases

| Case | Result |
|---|---|
| Call to a number no contractor has | `<Reject/>`, logged |
| Office answers in time | `answered_by = 'office'`, no AI, no text-back |
| Caller hangs up while the office phone rings | missed → text-back |
| Caller hangs up during the AI greeting | AI call (disclosed), wrap-up, no text-back |
| Gas call | safety script, then `<Dial>` on-call (handoff) |
| Engine throws mid-call | apology text, `{ type: 'end' }`, Sentry, wrap-up runs |
| Twilio retries a webhook | `webhook_events` makes it a no-op |
| Bad signature | 403, nothing saved |
| No `office_phone` | AI answers every call |

## Testing

- Webhook tests with signed form bodies (`twilio.getExpectedTwilioSignature` in tests): each
  route's TwiML and DB effect for the cases above.
- Relay websocket test with a `ws` client: `setup` → greeting state, `prompt` → `text` reply
  (engine mocked), transfer → `end` with `handoffData`, close → `endCall` called.
- Twilio SMS mapping functions unit tested; `sender.test.ts` with `SMS_PROVIDER=twilio` and the
  network call mocked.
- By hand on the trial account: call the number from a verified phone, book a visit, ask for a
  person, say "I smell gas", hang up while it rings.
