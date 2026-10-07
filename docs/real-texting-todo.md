# Real texting: what is left

Real texts go out through httpSMS for the Philippine demo
(`docs/superpowers/specs/2026-10-04-sms-service-design.md`). This file lists what is still
missing, and what a US launch would need on top.

## Done (2026-10-04, httpSMS)

- [x] A sending number per contractor (`phone_numbers`), keys in `.env` and `src/config/env.ts`.
- [x] `sendText()` saves the text in the caller's transaction; the sender loop sends it after the
      commit, so `sendRecoveryTexts` marking the draft in the same transaction is right.
- [x] Compliance gate: `blocked` with `no_consent` or `opted_out` (`src/modules/messaging/rules.ts`).
- [x] Delivery-status webhook, with repeats ignored through `webhook_events`.
- [x] STOP and START replies write `consent_events` with source `sms_reply`.
  - [x] A STOP blocks homeowner texts already waiting to go out.
- [x] Quiet hours: unprompted texts wait until `quiet_hours_end` (`send_after`).
  - [x] Checked again just before sending, so downtime or a retry never sends one at night.
- [x] Staff texts (sign-in codes, job alerts) skip consent and quiet hours. Sign-in codes are
      sent right away and their body is still never stored.
- [x] Sign-in codes come from the contractor's own sending number.
- [x] The development log of every text stays, under `SMS_PROVIDER=log`.

## Done (2026-10-05, homeowner messages)

- [x] `src/modules/homeowner-messages/`: booking confirmation (every way of booking), visit
      reminders 24 hours and 2 hours before (the `visit-reminders` job, every 5 minutes),
      receipt when the technician records an in-person payment, review request when a job is
      done (only with `tenants.review_url` set). Each goes as a text and, when the customer has
      an address, as an email.
- [x] Emails go through the same outbox as texts: a `messages` row with channel `email`,
      saved in the change's transaction and sent by the sender loop with the same retries.
      Emails skip consent and quiet hours.
- [x] Office alerts: `new_booking_alert` and `priority_alert` to owner and office users with a
      phone.

## Done (2026-10-05, technician job texts)

- [x] Technicians get a text (`job_assigned`) when a job is assigned, moved, reassigned, or removed.
      Texts use plain hyphens (GSM-7 friendly) and skip quiet hours and consent checks.
- [x] Texts for `assigned` and `changed` carry an expiring job-page link (`/j/<token>`).
      The link is validated via `jobs.tech_link_hash` (sha256). Valid links forward to `/jobs/:jobId`;
      reassigning, moving, cancelling, or deactivating invalidates the hash so older links
      show a clean expired page.
- [x] Removed texts tell the technician the job was taken off their list without any link.

## Homeowner messages: still open

- [ ] A 2-hour reminder for a visit that starts before quiet hours end (an 8 AM window) waits
      until 8 AM, so it arrives as the window opens. Decide: skip it, or let reminders through
      quiet hours.
- [ ] Emails have no unsubscribe link and go out from `EMAIL_FROM` with no Reply-To. Set
      Reply-To to the contractor's `contact_email` so replies reach them.
- [ ] Rescheduling sends no `booking_changed` text yet; the reminders follow the new time.
- [ ] Settings screen for `review_url` (today it can only be set in the database).

## Still to build

- [ ] The resume link (`bookingLink` in `online-booking.service.ts`) is always
      `https://<host>/`. A homeowner's phone can't open `localhost`, so a demo needs the web app
      on a public address (a tunnel or a deploy) and this link pointing at it.
- [ ] Decide what happens after the gas / carbon monoxide safety stop. A homeowner who taps
      "Yes" there already has a draft, so an hour later they would get "finish your booking",
      right after being told not to book online. Most likely: mark the draft so it is never
      texted (one more column, set by a small API call from the safety screen).
- [ ] Now that texts really go out, tell the homeowner in the wizard's Exit dialog: "We'll text
      you a link to finish."
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
- [ ] Office alerts by email too (module 10).

## US launch

- [ ] Twilio in place of httpSMS: replace `src/modules/messaging/httpsms.ts` and the webhook,
      checking the Twilio signature.
- [ ] Legal review of the consent wording (`CONSENT_WORDING` in `online-booking.service.ts`).
      A US telecom lawyer must approve it before real sending. Today it says "texts and calls
      about my visit": check that it covers a text about a booking the homeowner did not
      finish, and a text-back to a missed caller who never ticked the box.
- [ ] 10DLC registration for the sending numbers, including a campaign that covers one-time
      passcodes.

## Cost to plan for

Each text costs money: the SIM's load for httpSMS, per-message fees and carrier fees for
registered numbers in the US. Estimate the monthly volume before choosing a plan.
