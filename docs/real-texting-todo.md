# Real texting: to build later

Booking recovery (`docs/superpowers/specs/2026-09-30-booking-recovery-design.md`) ships with a
temporary `sendText()` in `src/modules/messaging/sms.ts`. It only saves a `queued` row to
`messages` and logs it. No text leaves the system. This file lists what is missing before it can.

## Must have before sending real texts

- [ ] Twilio account, a sending number per contractor (`phone_numbers` table already exists),
      and the keys in `.env` and `src/config/env.ts`.
- [ ] Replace the body of `sendText()` with the Twilio call. Keep the `messages` row: set
      `provider_message_id`, and move status from `queued` to `sent`, `failed` or `blocked`.
      A real send can't be rolled back, so `sendRecoveryTexts` must then mark the draft as
      texted before it sends, not in the same transaction.
- [ ] Compliance gate inside `sendText()`: no consent means `blocked` with reason
      `no_consent`; an opt-out means `blocked` with reason `opted_out`. Current consent is the
      newest `consent_events` row for the contractor, phone and channel.
- [ ] Delivery-status webhook: update `messages.status` to `delivered` or `failed`. Store the
      raw payload in `webhook_events`, checking the Twilio signature first.
- [ ] Inbound webhook for STOP and START replies: write a `consent_events` row with source
      `sms_reply` and its `message_id`, and honor it on every later send.
- [ ] Legal review of the consent wording (`CONSENT_WORDING` in `online-booking.service.ts`).
      A US telecom lawyer must approve it before real sending. Today it says "texts and calls
      about my visit": check that it covers a text about a booking the homeowner did not
      finish. 10DLC registration for the sending numbers is also required in the US.
- [ ] Quiet hours: no texts before 8 AM or after 9 PM in the homeowner's local time
      (`tenants.quiet_hours_start` and `quiet_hours_end` already exist).
- [ ] The resume link (`bookingLink` in `online-booking.service.ts`) is always
      `https://<host>/`. That is wrong on a developer's machine (`http`, port 5173). Fine while
      texts are only saved; fix it before testing real texts locally.
- [ ] Decide what happens after the gas / carbon monoxide safety stop. A homeowner who taps
      "Yes" there already has a draft, so an hour later they would get "finish your booking",
      right after being told not to book online. Most likely: mark the draft so it is never
      texted (one more column, set by a small API call from the safety screen).
- [ ] Once texts really go out, tell the homeowner in the wizard's Exit dialog: "We'll text
      you a link to finish." It was left out on purpose so the page never promises a text
      that isn't sent.
- [ ] Technician sign-in codes (`sign_in_code`) and other staff texts go to the contractor's
      own people, not homeowners: the consent check and quiet hours must not block them. Send
      `text.body` to Twilio, but keep storing the placeholder body for `sign_in_code`: the code
      itself must never be saved.
- [ ] Pick the number sign-in codes come from (the contractor's own, or one Relay number for
      everyone) and register a 10DLC campaign that covers one-time passcodes.
- [ ] Decide whether the development-only log of every text in `sendText()` stays. It is how
      developers without Twilio keys read sign-in codes.
- [ ] Make the 5-codes-per-hour cap atomic (delete, count and insert in one transaction that
      locks the technician's row), since the address limiter doesn't stop a burst from many
      addresses.
- [ ] Consider a daily cap on sign-in texts per phone, with an alert, since someone who knows
      a technician's number can use up their codes and tries.

## Should have

- [ ] Office dashboard list of unfinished drafts, so staff can call people who did not get or
      answer the text.
- [ ] "Call us instead" in the wizard's Exit dialog. Needs the contractor's office phone in
      the branding API, which doesn't return it today.
- [ ] Scheduled cleanup of drafts older than about 30 days.
- [ ] Recovery wait (60 minutes) and cutoff (24 hours) as contractor settings, not constants.
- [ ] A second reminder text, if the first one gets a good response.
- [ ] A per-contractor switch to turn recovery texts off.

## Cost to plan for

Each text costs money, and US carriers add fees for registered numbers. Estimate the monthly
volume before choosing a plan.
