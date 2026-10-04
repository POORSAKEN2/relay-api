# Setting up Gmail for emails

How to make Relay send real emails (booking confirmations) from a Gmail account.

How the code works: `docs/superpowers/specs/2026-10-04-booking-confirmation-design.md`.

Without any of this, Relay runs with `EMAIL_PROVIDER=log`: nothing is sent, and each email is
printed in the `relay-api` terminal.

## 1. Make an app password (once)

Gmail doesn't let apps sign in with the account password. It gives each app its own password.

1. Use a Gmail account made for the demo, not a personal one: every email goes out from it.
2. Turn on 2-Step Verification: Google Account → Security → 2-Step Verification.
3. Open https://myaccount.google.com/apppasswords, type `Relay` as the name and click
   **Create**.
4. Copy the 16-letter password Google shows (`abcd efgh ijkl mnop`). You can't see it again.

## 2. Set up relay-api

In `relay-api/.env`:

```
EMAIL_PROVIDER=smtp
SMTP_USER=relay.demo@gmail.com
SMTP_PASS=abcd efgh ijkl mnop
```

`SMTP_HOST` and `SMTP_PORT` default to Gmail (`smtp.gmail.com`, `465`). Restart `npm run dev`.

## 3. Check it works

Book a visit on the booking page with your own email in the email field. Within a few seconds
the email arrives, from the contractor's name. Replying to it goes to the contractor's contact
email, not to the Gmail account.

If it doesn't arrive, look in the `messages` table:

```sql
select status, attempts, last_error from messages where channel = 'email' order by created_at desc limit 5;
```

- `Invalid login` / `Username and Password not accepted`: the app password is wrong, or
  2-Step Verification is off.
- `failed` after 3 tries: Gmail refused it three times, a minute apart. The reason is in
  `last_error`.
- `sent` but not in the inbox: check Spam and Promotions.

## Limits

- About 500 emails a day per Gmail account. Past that, Google stops sending for a day.
- Emails from a Gmail address carrying a business's name can land in spam. A sending domain
  (SPF, DKIM) fixes that later.
