# Real emails with Gmail SMTP

Relay sends email (owner and office invites) through Gmail's SMTP server. With the default `EMAIL_PROVIDER=log` nothing is sent: each email is printed in the `relay-api` terminal on the line `Development only: the email`.

## Set up Gmail

1. Use a Google account that can turn on 2-Step Verification (Google Account, Security, 2-Step Verification).
2. Create an app password: <https://myaccount.google.com/apppasswords>. Name it `Relay`. Google shows 16 characters once; copy them.
3. Put this in `relay-api/.env`:

   ```
   EMAIL_PROVIDER=smtp
   SMTP_USER=you@gmail.com
   SMTP_PASSWORD=abcdefghijklmnop
   EMAIL_FROM=Relay <you@gmail.com>
   ```

   `SMTP_HOST` (`smtp.gmail.com`) and `SMTP_PORT` (`465`) already default to Gmail.
4. Restart the API. It refuses to start if `SMTP_USER`, `SMTP_PASSWORD` or `EMAIL_FROM` is missing.

## If an email doesn't arrive

| Problem | Fix |
|---|---|
| `Invalid login: 535` | Wrong app password, or 2-Step Verification is off. Create a new app password. |
| Goes to spam | Gmail sends as `SMTP_USER` whatever `EMAIL_FROM` says. Mark it "Not spam" once. |
| Timeout | Your network blocks port 465. Try `SMTP_PORT=587`. |

Gmail allows about 500 emails a day: plenty for invites, too low for bulk mail. Move to a transactional provider before real launch.
