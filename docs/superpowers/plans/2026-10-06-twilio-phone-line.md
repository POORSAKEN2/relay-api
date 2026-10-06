# Twilio Phone Line Implementation Plan

**Status: blocked until a Twilio account with a US number exists.**

**Goal:** The contractor's Twilio number rings the office, then the AI receptionist answers
through ConversationRelay; transfers, missed-call text-backs and recordings work; texts go
through Twilio. Telnyx is removed.

**Architecture:** `src/modules/voice/` is rewritten for Twilio: thin webhook routes that answer
TwiML, a `ws` server for ConversationRelay that calls the receptionist engine, and a status
webhook that calls `textBackMissedCall`. `messaging/` gets a Twilio sender and Twilio webhooks
that call the same `receiveText` / `updateTextStatus` core as httpSMS.

**Spec:** `relay-api/docs/superpowers/specs/2026-10-06-twilio-phone-line-design.md`

## Global Constraints

- Branch `feat/twilio-phone-line` in `relay-api`. Could be two PRs: voice first, texts second.
- Check every TwiML verb, ConversationRelay message and callback field against Twilio's
  current docs before relying on it (the spec is from memory).
- Lean, plain code a junior developer can debug without AI.
- Commit messages lowercase conventional. No `Co-Authored-By` trailer.
- Biome only on touched files. Keys go in `.env` only.

## Task 0: setup (by hand)

- [ ] Twilio trial account; buy a US local number with Voice and SMS.
- [ ] Add your own phone as a verified caller ID (trial accounts only call and text verified
      numbers).
- [ ] Insert the number into `phone_numbers` for the demo contractor (`desert`).
- [ ] Cloudflare Tunnel (as in `docs/httpsms-setup.md`) so Twilio reaches the local API.
- [ ] Write `docs/twilio-setup.md` while doing it; delete `docs/telnyx-setup.md` at the end.

## Task 1: settings, signature check, Telnyx out

- [ ] `npm install twilio ws` and `@types/ws`.
- [ ] `env.ts`: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `PUBLIC_API_URL`; remove `TELNYX_*`.
- [ ] `app.ts`: `express.urlencoded({ extended: false })` for `/api/webhooks/twilio`; remove the
      Telnyx raw-body line.
- [ ] `voice/twilio-signature.ts`: middleware using `twilio.validateRequest(authToken, signature,
      PUBLIC_API_URL + req.originalUrl, req.body)`; 403 when invalid. Test with
      `twilio.getExpectedTwilioSignature`.
- [ ] Delete `voice/telnyx.ts` and the Telnyx code in `voice.service.ts` / `voice.routes.ts` /
      `voice.test.ts`.
- [ ] Commit `refactor: twilio webhook signature check, telnyx removed`.

## Task 2: answering and the office ring

- [ ] `voice/twiml.ts` + test: tiny string builders `dialOffice(number, seconds, action)`,
      `connectAi(relayUrl, greeting, action)`, `dialTransfer(number)`, `hangUp()`, `reject()`.
      XML-escape every value.
- [ ] `voice.routes.ts`: `/webhooks/twilio/voice`, `/voice/dial-ended`, `/voice/ai-ended`,
      `/voice/status`, each with the signature middleware and `webhook_events` de-duplication
      (event id = `CallSid` + route + `CallStatus` / `DialCallStatus`).
- [ ] `voice.service.ts`: the decisions in the spec (business hours via
      `receptionist/transfer.ts`, office answered, missed → `textBackMissedCall`).
- [ ] Tests for each route and case in the spec.
- [ ] Commit `feat: twilio calls ring the office, then the ai`.

## Task 3: ConversationRelay

- [ ] `receptionist/engine.ts`: `answerWithAi(callId)` (existing row → `answered_by 'ai'`,
      `disclosed_at`, session) used by the relay; `startCall` stays for the test console.
- [ ] `voice/relay.ts`: `attachVoiceRelay(httpServer)` with a `ws` `WebSocketServer({ noServer:
      true })` and an `upgrade` handler for `/voice/relay` only (leave `/socket.io` alone).
      One small `switch` on `message.type` as in the spec's table. Errors → Sentry, apology
      text, `end`. `close` → `endCall`.
- [ ] `server.ts`: attach it next to `attachRealtime`.
- [ ] `relay.test.ts` with a `ws` client and the engine mocked.
- [ ] Commit `feat: ai receptionist answers on the phone through conversationrelay`.

## Task 4: recording

- [ ] At `setup`: `client.calls(callSid).recordings.create({ recordingStatusCallback, recordingStatusCallbackEvent: ['completed'] })`.
- [ ] `/webhooks/twilio/recording`: `RecordingStatus = completed` → `calls.recording_key = RecordingSid`.
- [ ] Commit `feat: record ai calls`.

## Task 5: texts through Twilio

- [ ] `messaging/twilio-sms.ts`: `sendSms` with the Twilio client (`messages.create({ from, to,
      body, statusCallback })`), returning the message SID as `providerMessageId`.
- [ ] `sender.ts`: pick the provider by `SMS_PROVIDER` (`log | httpsms | twilio`).
- [ ] Split `webhooks.service.ts`: provider-free `receiveText(tenantId, …)` and status update;
      httpSMS and new Twilio routes (`/sms`, `/sms-status`) translate into them.
- [ ] Tests mirroring `webhooks.test.ts` for the Twilio form fields.
- [ ] Commit `feat: send and receive texts through twilio`.

## Task 6: try it on the phone

- [ ] From the verified phone: book a visit; ask for a person; say "I smell gas"; hang up while
      it rings (text-back arrives); text the number (inbox); text STOP.
- [ ] Check `calls` rows, the job, the transcript, the summary note and the recording SID.
