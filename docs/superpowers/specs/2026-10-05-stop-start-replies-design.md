# STOP and START replies

Date: 2026-10-05. Status: draft. Plan: `docs/superpowers/plans/2026-10-05-stop-start-replies.md`.
Depends on: the SMS service (`2026-10-04-sms-service-design.md`), already built.

## Problem

The task: when `message.phone.received` arrives with the body `STOP` (any case), write a
`consent_events` row with `granted = false` and `source = 'sms_reply'`. `START` or `UNSTOP`
writes `granted = true`. No reply text goes back. `sendText()`'s consent check then blocks or
allows later texts.

**Most of this already exists** (commit `1fedb14`, `feat: httpsms webhook for delivery status,
replies and missed calls`):

- `receiveText()` in `src/modules/messaging/webhooks.service.ts` saves the inbound text, then
  matches `body.trim().toUpperCase()` against `STOP_WORDS` (`STOP`, `STOPALL`, `UNSUBSCRIBE`,
  `CANCEL`, `END`, `QUIT`) and `START_WORDS` (`START`, `UNSTOP`).
- `insertReplyConsent()` writes `channel = 'sms'`, `source = 'sms_reply'`, `message_id` = the
  inbound text (the `consent_events_reply_has_message` check requires it).
- Nothing is sent back.
- `consentProblem()` in `sms.ts` reads the newest row: `granted = false` blocks every homeowner
  kind with `opted_out`.
- `webhooks.test.ts` covers ` stop ` and `START`.

What is still wrong or untested:

1. **A STOP doesn't stop texts already waiting.** `sendText()` checks consent only when it
   saves the text. A text saved before the STOP and not yet handed to httpSMS still goes out:
   - a `reminder` saved at 21:30 and held for quiet hours until 08:00, homeowner texts STOP
     at 22:00, gets the reminder at 08:00;
   - any text waiting for a retry after an httpSMS error (`attempts` > 0, still `queued`).

   The sender loop (`sender.ts`) never looks at consent. This is the one real gap.
2. **`STOP.` and `Stop!` don't count.** httpSMS is an Android phone on a normal SIM: no carrier
   catches STOP for us, so Relay is the only thing honoring it. People type punctuation.
3. **Untested:** `UNSTOP`, the other stop words, a sentence that merely contains "stop", that
   no reply is sent, and the round trip webhook STOP → `sendText()` blocked → START → allowed.

## Goal

1. After a STOP, no homeowner text leaves Relay for that number at that contractor, including
   texts already waiting. Texts already handed to httpSMS can't be called back.
2. `STOP`, `Stop.`, ` stop! ` all opt out. `Please stop texting me` does not.
3. Tests prove the whole round trip.
4. No schema change.

## Out of scope

- Re-checking consent inside the sender loop. Blocking waiting texts at STOP time does the same
  job in one place, in the webhook's transaction (see Decisions).
- Reviving texts on START. A blocked reminder is stale by then; new texts flow again normally.
- Staff and technician numbers. Their kinds have `consent: 'none'` (`rules.ts`). A technician
  who texts STOP gets a consent row like anyone, but sign-in codes and job alerts still go:
  they need them to work. Unchanged.
- A confirmation text ("You're unsubscribed"). The task says none. US carriers send their own;
  revisit with Twilio and 10DLC.
- An inbox or UI for opt-outs. The row is in `consent_events`; the export ZIP already has it.

## Decisions

### Keep the wider stop list

The task names only `STOP`. The code also accepts `STOPALL`, `UNSUBSCRIBE`, `CANCEL`, `END`,
`QUIT`, the standard US carrier list. Missing a real opt-out is the costly mistake; a wrong one
is undone by texting `START`. Keep it.

`START` from someone with no consent row counts as consent: it is an explicit request for texts.
Unprompted kinds (`reminder`, `review_request`, …) can then reach them. Accepted, and noted in
the code comment.

### Matching

```
word = body.trim().replace(/[.!]+$/, '').toUpperCase()
```

Whole message only, trailing `.` or `!` dropped. `STOP.` and `stop!!` match; `stop please`,
`Don't stop` and `STOP?` don't. A question isn't an instruction.

### Blocking waiting texts

On a STOP, in the same transaction as the consent row, one update:

```
status = 'blocked', blocked_reason = 'opted_out'
where tenant_id = $tenant and contact = $contact
  and channel = 'sms' and direction = 'outbound'
  and status = 'queued' and provider_message_id is null
  and kind in (<homeowner kinds>)
```

- `provider_message_id is null`: not yet handed to httpSMS. Same filter as the sender's
  `messages_due_idx`.
- Homeowner kinds = every kind whose rule has `consent` other than `'none'`. Exported from
  `rules.ts` as `HOMEOWNER_KINDS`, built from `TEXT_RULES`, so one table decides both
  `sendText()` and this. A new kind is placed automatically.
- Same status and reason `sendText()` would have written, so screens and the export need no
  change.

Why not re-check consent in the sender loop: it adds a query per text on a 5-second loop and
splits the consent rule between two files. The STOP is the only event that turns a waiting
text bad, so the STOP handler is where to act.

Accepted race: the sender has claimed a text and is inside the httpSMS call when the STOP
lands. The update marks it `blocked`, httpSMS sends it anyway, `markHandedOver` saves the
provider id. One text, seconds wide. The row says `blocked` while the phone sent it; the
`message.phone.sent` webhook won't move it (it only moves `queued`). Not worth a lock.

## Code changes

```
webhooks.service.ts ── receiveText() ──► messaging.queries.ts
                          │                 insertReplyConsent()   (exists)
                          │                 blockWaitingTexts()    (new)
                          └──► rules.ts     HOMEOWNER_KINDS        (new)
```

- `rules.ts`: `HOMEOWNER_KINDS`, the kinds whose rule checks consent.
- `messaging.queries.ts`: `blockWaitingTexts(tenantId, contact, kinds, tx)`.
- `webhooks.service.ts`: the punctuation-tolerant match; on a STOP, call `blockWaitingTexts`
  after `insertReplyConsent`.

## Edge cases

| Case | Result |
|---|---|
| `STOP` from a number with no customer record | consent row (keyed by phone, not customer) |
| `STOP` twice | two rows; newest still `false`. Harmless, and the log shows both |
| `STOP` to contractor A | blocks A's texts only. B's consent is separate |
| `STOP` then `START` | newest is `true`: `opt_out` kinds go; `required` kinds go too |
| `START` with nothing waiting | consent row only |
| Reminder held for quiet hours, then `STOP` | reminder `blocked`, `opted_out` |
| Text already handed to httpSMS, then `STOP` | untouched; it is on the phone |
| Technician texts `STOP` with a `job_assigned` waiting | still goes (`consent: 'none'`) |
| `STOP` from an unknown contractor number | 200, nothing saved (existing) |
| Webhook retried | `webhook_events` dedupe: one consent row (existing) |
| `Stop sending me reminders` | saved as an inbound text only |

## Testing

- `rules.test.ts`: `HOMEOWNER_KINDS` has `on_my_way`, `text_back`, `reminder`; not
  `sign_in_code`, `job_assigned`, `new_booking_alert`, `inbound`.
- `webhooks.test.ts`:
  - each stop word and `Stop.` / `stop!` write `granted = false`; `UNSTOP` writes `true`;
  - `Please stop texting me` and `STOP?` write no consent row;
  - after a STOP the only `messages` row is the inbound one: no reply;
  - a held `reminder` and a retrying `on_my_way` become `blocked` / `opted_out`; one already
    handed over (`provider_message_id` set), a technician's `job_assigned`, and another
    contractor's text to the same number stay `queued`;
  - round trip: webhook STOP → `sendText(text_back)` is `blocked`; webhook START →
    `sendText(text_back)` is `queued`.
- Docs: `docs/httpsms-setup.md` step 5 and `docs/real-texting-todo.md`.
