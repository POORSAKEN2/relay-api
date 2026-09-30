# Booking recovery: save unfinished bookings and text a link back

Date: 2026-09-30. Status: approved. Plan: `docs/superpowers/plans/2026-09-30-booking-recovery.md`.

## Problem

A homeowner who quits the booking wizard halfway is lost. Nothing is saved before the last
step, the answers live only in the browser tab, and the office never learns the person existed.

## Goal

1. A refresh or a return visit resumes the wizard where the homeowner stopped.
2. An unfinished booking becomes a saved draft with a name and phone number.
3. A homeowner who agreed to texts and doesn't finish gets one text with a link to resume
   (real sending is a later job; v1 only saves the text as `queued`).
4. An Exit button on every step so leaving is a choice, not an accident.

## Out of scope for v1

Listed again in `docs/real-texting-todo.md` where they matter.

- Real text sending (Twilio), delivery status, STOP replies, quiet hours.
- Telling the homeowner "we'll text you a link". Nothing is sent yet, so the wizard must not
  promise it.
- An office dashboard list of unfinished drafts.
- Deleting old drafts on a schedule.
- A second reminder text.
- Moving the 60-minute wait and 24-hour cutoff into contractor settings (constants for now).

## Data: `booking_drafts`

One row per homeowner who gave a name and phone number in the wizard.

| Column | Meaning |
| --- | --- |
| `id`, `tenant_id` | As everywhere: every query takes `tenantId` first. |
| `token` | 32 random bytes, hex. Unique. The only key the browser and the resume link use. Stored as-is, unlike job links: the recovery job needs it to build the link, and it opens nothing the row doesn't already hold. |
| `name`, `phone` | Phone in E.164, same rules as `callback_requests`. |
| `zip` | Already checked against the service area. |
| `answers` | JSON copy of the wizard answers so far: service, problem, system type, the two priority flags. Validated with Zod on write. The arrival window is left out on purpose: open windows change, so a homeowner who comes back picks one again. |
| `sms_consent` | True when the homeowner ticked the text-consent box. The proof (exact wording, IP) goes to `consent_events`. |
| `last_activity_at` | Set whenever the homeowner saves something. The recovery job waits on this. |
| `recovery_texted_at` | Set once when the recovery text is saved. Null means not yet. |
| `booked_job_id` | Set when the booking succeeds. A booked draft is never texted and can't be resumed. |
| `created_at` | As everywhere. |

Rules:

- Text consent is optional and never a condition of booking (US rules do not allow making
  marketing-style texts a condition of a purchase). A draft is saved either way, so a refresh
  still resumes. Only a draft with `sms_consent` true is ever texted.
- The token identifies a draft, not the phone. A second draft for the same phone is allowed.

## API (`modules/online-booking`)

All routes use `tenantFromHost`. Draft routes share one rate limit of their own, larger than
the forms' one, because answers are saved in the background on every step.

- `POST /online-booking/drafts` takes `{ name, phone, zip, consent, token? }` and returns
  `{ token }`. Without a token, or with one that matches no open draft, it creates a draft and
  writes an audit event. With the token of an open draft it updates that draft's name, phone,
  ZIP and consent, so going back to the step never leaves a second draft behind.
  A ticked box writes `consent_events` rows (channels `sms` and `voice`, source
  `booking_form`, like a booking does). Unticking a box that was ticked writes `granted: false`
  rows for the phone it was given for. It fails with `422` when the ZIP is outside the service
  area.
- `PATCH /online-booking/drafts/:token` replaces `answers` and sets `last_activity_at`. `404`
  when the token is unknown, for another tenant, or already booked.
- `GET /online-booking/drafts/:token` returns `{ name, phone, zip, consent, answers }` so the
  wizard can resume. Same `404` rule.
- `POST /online-booking/bookings` accepts an optional `draftToken`. On success it sets
  `booked_job_id`. An unknown token is ignored: a draft must never stop a booking. Consent
  works as before: the wizard sends the answer from the contact step as `consent`.

## Recovery job (`pg-boss`, every 5 minutes, `booking-recovery`)

Picks drafts where all of these hold:

- `sms_consent` is true, `booked_job_id` is null and `recovery_texted_at` is null;
- `last_activity_at` is more than 60 minutes ago and `created_at` is less than 24 hours ago;
- no job was created for that phone number since the draft began (the homeowner may have
  called the office instead).

For each one, in one transaction, it calls `sendText()` with the resume link
`https://<tenant host>/?resume=<token>` and sets `recovery_texted_at`. A failure goes to Sentry
through `reportFailures` and the draft stays eligible for the next run.

## Temporary `sendText()`

`modules/messaging/sms.ts` exports `sendText(tenantId, { contact, kind, body })`.
In v1 it does not send anything. It inserts a `messages` row with `channel: 'sms'`,
`direction: 'outbound'`, `status: 'queued'` and logs that the text was saved, not sent.
Replacing this one function with a Twilio call is the whole change later. Everything in
`docs/real-texting-todo.md` is needed before it can send for real.

## Wizard (`relay-web/src/features/booking`)

- New step `contact` between `zip` and `problem`: "Where should we reach you?" with name, mobile
  and one optional consent checkbox using `consentWording`. Continuing calls `POST /drafts`.
  A failure is shown like the ZIP check's, and the homeowner can try again.
  `STEPS`, `STEP_TITLES`, `isAnswered` and `steps.test.ts` change with it.
- The details step loses name, phone and the consent checkbox. It keeps email and address.
- After each later step, answers are sent with `PATCH`. A failed save shows nothing and never
  blocks the wizard.
- The draft token is kept in `localStorage`, wrapped in try/catch because it can be blocked.
  On load, `?resume=<token>` or a stored token fetches the draft and the wizard opens at the
  first unanswered step. A `404` drops the stored token; any other failure keeps it for next
  time. Either way the wizard starts fresh. A saved service the contractor no longer offers
  is dropped.
- The booking request sends `draftToken`, and the contact step's consent answer as `consent`.
  Unticked consent means no texts of any kind, and the booking still goes through.
- Exit button: beside the step title on every step. It opens a small dialog with "Keep
  booking" and "Leave". Leave shows a "You can close this page" screen with a way back.
- A finished booking and "Book another visit" clear the stored token.

## Errors

- Answer save (`PATCH`) fails: silent. The homeowner can still book.
- Draft fetch fails: start fresh (see above).
- Name or phone missing or invalid on the contact step: field messages from the API, like the
  other forms. Both are needed to book, so the step cannot be skipped.
- Consent box unticked: allowed. No consent event is written and no text is ever sent.

## Testing

- API (`vitest`, like `online-booking.test.ts`): create requires a served ZIP; create writes
  consent events only when `consent` is true; a second `POST` with the token updates the same
  draft; `PATCH`/`GET` respect tenant and booked state; a booking with `draftToken` sets
  `booked_job_id`, and still books with an unknown token; the recovery job picks only drafts
  in the 60-minute to 24-hour range, skips drafts without consent, booked drafts, drafts whose
  phone has a job since, and already-texted drafts, and saves one text each.
- Web (`vitest`, no browser): `steps.test.ts` for the new step order, the "first unanswered
  step" rule and the draft helpers; a small test for the stored-token helper (storage
  blocked, token kept, token forgotten).

## Order of work

1. API: table and migration, draft routes, booking `draftToken`, tests.
2. API: `sendText()` stub, recovery job, tests.
3. Web: contact step, details changes, draft saving, resume, tests.
4. Web: Exit button, dialog and "left" screen.
