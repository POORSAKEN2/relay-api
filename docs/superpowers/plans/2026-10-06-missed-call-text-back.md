# Missed-Call Text-Back Implementation Plan

**Goal:** A missed call with a caller number gets one text within 30 seconds with a booking link
that pre-fills the phone. A booking from that link is saved as `text_back`.

**Architecture:** New `calls` module with one core function, `textBackMissedCall()`, called by
the httpSMS webhook now and the Twilio webhook later. The booking page reads `?phone=` and
`?call=`; `bookVisit` turns a valid call id into `source = 'text_back'`.

**Spec:** `relay-api/docs/superpowers/specs/2026-10-06-missed-call-text-back-design.md`

## Global Constraints

- Branch `feat/missed-call-text-back` in **both** `relay-api` and `relay-web`, from `main`.
- Lean, plain code a junior developer can debug without AI. Short "why" comments.
- Commit messages lowercase conventional (`feat: …`). No `Co-Authored-By` trailer.
- Biome only on touched files: `npx biome check --write <paths>`.
- Tests need the local test database (`npm test`).

## Task 1: `sendText` accepts a call id

- [ ] `src/modules/messaging/sms.ts`: add `callId?: string // the missed call a text-back answers`
      to the `text` parameter. It is spread into `insertMessage` already (`...text`).
- [ ] `npm test -- sms` passes.

## Task 2: the `calls` module

- [ ] `src/modules/calls/calls.queries.ts`:
      - `findMissedCall(tenantId, callId, tx)`: the call joined to `tenants` (name, slug,
        customDomain, customDomainVerifiedAt), only when `answered_by is null`.
      - `textedBackSince(tenantId, contact, since, tx)`: true if a `messages` row exists with
        that contact, `kind = 'text_back'`, `status <> 'blocked'`, `created_at >= since`.
      - `findRecentMissedCall(tenantId, callId, since, tx)`: for the booking check (Task 4).
- [ ] `src/modules/calls/calls.service.ts`:
      ```ts
      // At most one text-back per caller in this window, however many times they ring.
      const TEXT_BACK_GAP_HOURS = 12

      // Texts a caller nobody answered a link to book online (flow B, the dashed line). Runs in
      // the transaction that saved the call, so the call and its text are saved together.
      export async function textBackMissedCall(tenantId: string, callId: string, tx: Tx) {
        const call = await queries.findMissedCall(tenantId, callId, tx)
        if (!call?.fromPhone) return // hidden caller ID: nobody to text
        const since = new Date(Date.now() - TEXT_BACK_GAP_HOURS * 3_600_000)
        if (await queries.textedBackSince(tenantId, call.fromPhone, since, tx)) return

        const link = tenantUrl(call.tenant, `/?call=${call.id}&phone=${encodeURIComponent(call.fromPhone)}`)
        await sendText(
          tenantId,
          {
            contact: call.fromPhone,
            kind: 'text_back',
            body: `${call.tenant.name}: sorry we missed your call. Book a visit here: ${link} Reply STOP to opt out.`,
            callId: call.id,
            customerId: call.customerId ?? undefined,
          },
          tx,
        )
      }
      ```
- [ ] `src/modules/messaging/messaging.queries.ts`: `insertMissedCall` returns the new id,
      `undefined` on conflict (`.onConflictDoNothing().returning({ id: calls.id })`).
- [ ] `src/modules/messaging/webhooks.service.ts → recordMissedCall`: after the insert,
      `if (id) await textBackMissedCall(found.tenantId, id, tx)`. Update the comment ("Texting
      the caller back is the text-back feature's job") to say what happens now.
- [ ] `src/modules/calls/calls.test.ts`: the cases in the spec's Testing section.
- [ ] `webhooks.test.ts`: the missed-call test checks the queued `text_back` (contact, `call_id`,
      body has `?call=`); the repeat-event test checks there is still one.
- [ ] Commit `feat: text missed callers a booking link`.

## Task 3: booking remembers the call (relay-api)

- [ ] `online-booking.schemas.ts`: `BookingInput` and `DraftAnswersInput.answers` get
      `callId: z.uuid().optional()`. `DraftAnswers` in `schema.ts` gets `callId?: string`.
- [ ] `online-booking.service.ts → bookVisit`: inside the transaction, before inserting the job:
      ```ts
      // A booking from a missed-call text counts as recovered. Any other id is ignored:
      // a stale or wrong link must never stop a booking.
      const callId = input.callId ?? draft?.answers.callId
      const call = callId
        ? await calls.findRecentMissedCall(tenant.id, callId, sevenDaysAgo(), tx)
        : undefined
      ```
      then `source: call ? 'text_back' : 'web'`, `callId: call?.id`. Move the draft lookup above
      the job insert so its answers are available (it is already in the transaction). The audit
      `data.source` uses the same value.
- [ ] `online-booking.test.ts`: valid id → `text_back` + `call_id`; unknown id, another
      contractor's call, answered call, call 8 days old → `web`, no `call_id`; id only in the
      draft's answers → `text_back`.
- [ ] Commit `feat: bookings from a missed-call text count as recovered`.

## Task 4: the booking page reads the link (relay-web)

- [ ] `src/features/booking/booking-flow.tsx`: read `phone` and `call` once, like `resume`:
      `const [fromCall] = useState(() => ({ phone: params.get('phone') ?? '', callId: params.get('call') ?? undefined }))`.
      Pass them to the wizard.
- [ ] The wizard's starting answers (`steps.ts`, where `phone: ''` is set): use the link's
      phone when there is no saved draft. Keep the value E.164; the contact step already formats
      it for display (`formatPhone`).
- [ ] Send `callId` with the draft answers (`saveDraftAnswers`) and with the final booking.
      `features/booking/api.ts` schemas get the optional field.
- [ ] Test the pure part (starting answers from the link) in `steps.test.ts`.
- [ ] Commit `feat: booking link from a missed-call text fills in the phone`.

## Task 5: check by hand

- [ ] With `SMS_PROVIDER=log`, post a signed `message.call.missed` event to the local API (see
      `docs/httpsms-setup.md` for the signature), check the logged text and its link.
- [ ] Open the link on the local web app: phone filled in, book, check the job's `source` and
      `call_id` in psql, and that `/api/analytics/recovery` counts it.
