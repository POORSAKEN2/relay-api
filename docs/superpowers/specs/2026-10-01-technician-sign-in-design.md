# Technician sign-in with a text code

Technicians have no email or password. They sign in with the mobile number the office saved
for them on the Technicians screen, and a 6-digit code texted to that number. Office staff and
the Relay superadmin keep signing in with email and password.

Nothing is really texted yet: `sendText()` is still the temporary version that only saves a
`queued` row (`docs/real-texting-todo.md`). Until Twilio is in, a developer reads the code in
the API terminal. When Twilio lands, only `sendText()` changes; sign-in does not.

## Decisions

| Question | Decision |
|---|---|
| Who sends the code | The API, straight to the technician's phone. The office never sees or passes on codes. |
| What the database keeps | Only an HMAC-SHA256 of the code, keyed with `SIGN_IN_CODE_SECRET` (as the `sign_in_codes` table already says). The `messages` row for the text stores `Sign-in code (not stored)` instead of the text. |
| How long a code works | 10 minutes, once, 5 tries. Only the newest code works: asking again replaces the old one. |
| How often a phone can get a code | At most 5 codes per hour per phone. Each text costs money and could be used to pester someone. |
| Rate limit | The existing sign-in limiter (10 requests per 15 minutes per address) also covers both phone routes, counted together with email sign-in. |
| Unknown number | Same answer as a known one (204, nothing sent), like a wrong email. Wrong code, used code, expired code and unknown number all get the same 401. |
| Deactivated technician | Gets no code and can't sign in. (Deactivating already ends their sessions and deletes their codes.) |
| How long they stay signed in | The existing 30-day session, extended while in use. On their own phone they rarely sign in again ("remembered on the phone" in the tech stack doc). |
| Contractor | Not checked against the hostname, same as email sign-in: a phone number belongs to exactly one technician. The text names the technician's contractor. |
| In development | `sendText()` also logs the text (with the code) when `NODE_ENV=development`. Never in test or production. |

## API

| Route | Access | Body | Answer |
|---|---|---|---|
| `POST /api/auth/phone/code` | public, sign-in rate limit | `{ phone }`, any US format | `204` always; `400 validation_failed` for a malformed number |
| `POST /api/auth/phone/sign-in` | public, sign-in rate limit | `{ phone, code }` | `200 { user }` and the session cookie; `401 unauthorized` "That code is wrong or has expired. Ask for a new one." |

Text: `<Contractor name>: your sign-in code is 123456. It expires in 10 minutes.`

Checking a code: find the technician's newest code, use up one try with a single conditional
`UPDATE` (unused, unexpired, under 5 tries), compare hashes in constant time, then mark it used
with another conditional `UPDATE`, so two requests can't both use it. Old codes (over an hour)
are deleted when a new one is asked for, so the table never grows past a few rows per
technician and needs no cleanup job.

New setting: `SIGN_IN_CODE_SECRET`, at least 32 characters, required. `.env.example` carries a
development-only value; production sets its own.

## Web

- `/sign-in/phone`: number first ("Text me a code"), then the code ("Sign in"), with "Text me
  a new code" and "Use a different number". Code field uses `autocomplete="one-time-code"` so
  phones offer the code from the text.
- `/sign-in` links to it ("Technician? Sign in with a text code") and back.
- Technicians land on `/jobs`, a placeholder ("Your jobs") with a sign-out button. Today's jobs
  arrive with the jobs module.
- `/jobs` and `/jobs/:token` are technician-only. Signed out, they go to `/sign-in/phone?next=…`
  and come back after signing in.

## Not in this change

The technician's job list and job page (jobs module), real texting (Twilio, 10DLC), reading
the code automatically from the text (WebOTP), job links that sign in by themselves.
