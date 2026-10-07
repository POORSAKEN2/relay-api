# MVP remaining work: road to the AI receptionist

Date: 2026-10-06. Status: plan of record. Source: the MVP scope, booking flows and tech stack PDFs
(`relay/documentation/`), checked against `relay-api` and `relay-web` `main` today.

## Where each MVP module stands

| # | Module | State | What is left |
|---|---|---|---|
| 1 | White-label setup | Built (branding, contractors, custom domain fields) | Phone number and 10DLC setup: Twilio phase |
| 2 | Online booking | Built (no online payment, decided 2026-10-03) | Homeowner reschedule / cancel page (`manage_link_hash` exists, no page) |
| 3 | Missed-call text-back | Call is recorded (httpSMS `message.call.missed`); **no text goes out**; **no inbox** | Text-back sender, two-way inbox |
| 4 | AI receptionist | Telnyx setup stub only | Everything: LLM client, engine, test console, wrap-up, phone line |
| 5 | Lead recovery | Abandoned-booking text built | Missed-caller reminder (`missed_caller_reminder`) |
| 6 | Scheduling and dispatch | Built | "Booking changed" text to the homeowner (`booking_changed`) |
| 7 | Customers | Built | — |
| 8 | Technician job page | Built | — |
| 9 | Payments | In-person payment recorded (invoices written by `recordPaymentInPerson`) | Card links on hold (payments decision) |
| 10 | Notifications | Confirmation, reminders, technician and office texts built | Waitlist offer (`waitlist_offer`), `booking_changed` |
| 11 | Recovered-revenue dashboard | API built (`GET /api/analytics/recovery`) | The page in `relay-web` still shows `—` |
| 12 | Compliance | Consent log, STOP / START, quiet hours, audit log built | AI and recording disclosure (comes with module 4), lawyer review |
| 13 | Ownership and accounts | Built (roles, staff, export, subscription, per-job billing) | — |

## Decisions

- **One provider for calls and texts: Twilio** (voice with ConversationRelay, SMS, numbers,
  10DLC). Replaces Telnyx (calls) and, for real pilots, httpSMS (texts). httpSMS can stay for
  local development.
- **Build the AI receptionist before the phone number.** The receptionist is text in, text out.
  ConversationRelay turns speech into text and back, so the engine is built and tested in a
  chat window first, and the phone line is a thin adapter added last.
- **Webhooks stay thin, the logic is provider-free.** A missed call, an inbound text and an AI
  turn each have one core function. httpSMS today and Twilio later only translate their
  webhook into a call to it.

## Build order

Each line is one spec and plan in `docs/superpowers/`, one branch, one PR.

| Order | Subtask | Repos | Needs a phone number? | Spec |
|---|---|---|---|---|
| 1 | Missed-call text-back | api + web | No (httpSMS) | `specs/2026-10-06-missed-call-text-back-design.md` |
| 2 | Two-way text inbox | api + web | No | `specs/2026-10-06-text-inbox-design.md` |
| 3 | Recovered-revenue page | api + web | No | `specs/2026-10-06-analytics-page-design.md` |
| 4 | LLM client | api | No | `specs/2026-10-06-llm-client-design.md` |
| 5 | Receptionist engine | api | No | `specs/2026-10-06-receptionist-engine-design.md` |
| 6 | Receptionist test console | api + web | No | `specs/2026-10-06-receptionist-test-console-design.md` |
| 7 | Call wrap-up | api + web | No | `specs/2026-10-06-call-wrap-up-design.md` |
| 8 | Twilio phone line | api | **Yes** | `specs/2026-10-06-twilio-phone-line-design.md` |

1 to 3 are short and independent: they finish modules 3 and 11 and make the dashboard show real
numbers. 4 to 7 are the AI receptionist, in dependency order. 8 is blocked until a Twilio account
with a US number exists.

## Not code, start now

- **Twilio account.** Start a trial (one free US number, calls and texts only to verified
  numbers). Upgrade before any contractor demo.
- **10DLC registration** for the first pilot shop: campaign review takes 10 to 15 days lately.
- **US telecom lawyer.** Questions to bring:
  1. Does "I agree to get texts and calls about my visit, like confirmations and reminders"
     (`CONSENT_WORDING`, `online-booking.service.ts`) cover the abandoned-booking text to
     someone who never finished booking?
  2. Is a missed-call text-back to a caller who never gave consent allowed? (Relay treats it as
     a reply to the caller's own call: `text_back` is opt-out only, `messaging/rules.ts`.)
  3. Is the spoken consent question the AI asks before texting a confirmation enough, and is
     storing its exact wording with the call id enough proof?
  4. The AI and recording disclosure wording, for all-party consent states (Florida, California).
  5. Wording for the 10DLC campaign (sample messages, opt-in description).

## After the receptionist (not specced yet)

Small items that close the remaining MVP gaps, in rough priority:

1. **Callback list** for the office: `callback_requests` (web "outside our area" form, and the
   AI's `take_message`) has no screen yet. Needed before AI pilots, or messages are lost.
2. **Call log** screen: every call, who answered, outcome, transcript, summary.
3. Homeowner **reschedule / cancel** page from the confirmation link.
4. **Waitlist offer** text when a window frees up.
5. **Missed-caller reminder**: one text the next morning to a missed caller who didn't book.
6. **Booking changed** text when the office moves a job.

## Defaults chosen in these specs (confirm or change)

1. Phone bookings send no card link (payments decision 2026-10-03).
2. The AI speaks English only for the first pilots.
3. The AI books on the caller's "yes", with no hold during the call. A window that filled in the
   meantime gets an apology and the next window.
4. The test console is off in production (`RECEPTIONIST_TEST_CONSOLE`), and its bookings are real
   jobs.
5. At most one text-back per caller every 12 hours.
6. The recovered-revenue page is owner-only (like the API), with plain CSS bars, no chart library.
7. The office can only reply to existing text threads, not text any number.
8. "Business hours" (for transfers) = the span of the day's arrival windows.
9. Call recordings stay on Twilio at first; `calls.recording_key` holds the Twilio recording SID.
