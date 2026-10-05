# Booking widget and Google Business Profile link

Date: 2026-10-05. Status: draft, waiting for review.
Builds on: `2026-10-04-waitlist-offer-design.md` (the wizard's one-time URL parameters,
`?offer=`), `2026-10-03-contractor-lifecycle-design.md` (a suspended contractor's booking page is
off) and `2026-09-30-booking-recovery-design.md` (drafts and the recovery text).

## Problem

A contractor's booking page lives at `https://<slug>.<APP_DOMAIN>/` (or their verified custom
domain, `tenantUrl`). The only way to reach it is a plain link the contractor writes by hand, as
the demo `contractor-site` does. Relay shows the contractor neither their booking link nor
anything to put on their website or their Google Business Profile, and a booking doesn't record
where the homeowner found the page.

## Goal

1. In **Booking settings**, the contractor finds their booking link, a link for their Google
   Business Profile, and a one-line snippet for their website, each with Copy.
2. The snippet adds a **"Book online" button** in the contractor's brand color to their site.
   Tapping it opens the booking wizard **in a popup over their page** (full screen on phones), so
   the homeowner never leaves the site.
3. A booking made from the **Google link** or the **website button** remembers it, and the job
   shows "Booked online · from Google" or "· from your website".

Done means: a contractor pastes the snippet into their site, a homeowner books through the popup
on a phone, and the dispatch board shows where the booking came from. No staff page of Relay can
be shown inside another site.

## Out of scope

- Counts or reports by where bookings came from.
- Any Google API (Reserve with Google, posting to the profile). The Google link is a plain link
  the contractor pastes in themselves.
- Choosing the button's wording, position or a color other than the brand color.
- An inline (on-page) wizard or a styled link without a popup.
- The admin page: the card is in the contractor's own Booking settings only.
- Fixing CORS for custom domains on other public routes (today only subdomains of `APP_DOMAIN`
  pass `checkOrigin`).

## The three things to copy

Built from `tenantUrl(tenant, path)`, so a verified custom domain is used once there is one:

| Row | Value |
|---|---|
| Your booking link | `tenantUrl(tenant, '/')` |
| Google Business Profile | `tenantUrl(tenant, '/?from=google')` |
| Website button | `<script src="<tenantUrl(tenant, '/widget.js')>" async></script>` |

The API returns all three (below); the web app never builds them, because only the API knows
whether the custom domain is verified.

## API: `relay-api`

### `GET /api/settings/booking-links` (staff, signed in)

Same access as the other Booking settings routes (`requireRole('owner', 'office')`, in
`settings.routes.ts`). Returns:

```json
{
  "bookingUrl": "https://desert.relay.app/",
  "googleUrl": "https://desert.relay.app/?from=google",
  "widgetSnippet": "<script src=\"https://desert.relay.app/widget.js\" async></script>",
  "bookingOpen": true
}
```

`bookingOpen` is `false` when the contractor is `suspended` (the booking page answers 410 then).

### `GET /api/online-booking/widget?host=<booking host>` (public, any origin)

What the button needs: `{ "primaryColor": "#1d4ed8", "open": true }`. `host` is the booking
page's hostname (`desert.relay.app`), parsed with `parseTenantHost` and looked up with
`findTenantByHost`, as `tenantFromHost` does. It takes `host` as a query parameter instead of the
`X-Tenant-Host` header so the browser sends it without a preflight.

- Unknown host or bad `host`: 404 `not_found`.
- Suspended contractor: 200 with `open: false` (the script then shows no button).
- `primaryColor` is the current branding version's, else the default (`#1d4ed8`).
- CORS: `Access-Control-Allow-Origin: *`, no credentials. The route is mounted in `app.ts`
  **before** the global `cors({ origin: checkOrigin, credentials: true })`, with its own
  `cors({ origin: '*' })`, so the global one never answers for it. It returns only public facts.
- `Cache-Control: public, max-age=300`: a rebrand reaches the button within 5 minutes.

### `bookedVia` on a booking

- `BookingInput.bookedVia?: 'google' | 'widget'`. Any other value is a 400 `validation_error`,
  like other bad fields.
- `DraftAnswersInput.answers.bookedVia?: 'google' | 'widget'`, kept in the draft's answers, so a
  booking finished later (from the recovery text, or the same browser) is still credited.
- `bookVisit` stores `input.bookedVia ?? draft?.answers.bookedVia ?? null` in the new column.

## Data

`jobs.booked_via text null`, with a check `booked_via in ('google', 'widget')`. `BOOKED_VIA =
['google', 'widget'] as const` in `schema.ts`. Null means the plain link, or not known (office,
AI, text-back, older jobs). It sits beside `source`, which says *how* the job was booked
(`web`, `recovery_text`, ...); `booked_via` says *where the homeowner found the page*. One
migration, `0015_jobs_booked_via`.

The job in the dispatch and job-page responses gains `bookedVia: 'google' | 'widget' | null`.

## Web: `relay-web`

### Booking settings: "Share your booking page"

A card at the top of `routes/settings.tsx`, above "Priority fee", from `useBookingLinks()`:

- Three rows (table above), each with the value in a read-only box and a **Copy** button that
  shows "Copied" for 2 seconds (`navigator.clipboard.writeText`; if that fails, the text is
  selected and a toast says "Press Ctrl+C to copy").
- Under the Google row: "In your Google Business Profile, open Edit profile → Booking, and add
  this as your appointment link."
- Under the snippet: "Paste this just before `</body>` on every page of your website. It adds a
  'Book online' button in your brand colors." plus a **Preview** link to `/widget-preview`.
- `bookingOpen: false`: a note at the top of the card, "Your booking page is off. These links
  will work once it's turned on."

`/widget-preview` is a page of the app (staff only): a plain gray page with placeholder text and
the contractor's widget snippet loaded, so the button and popup can be tried.

### `widget.js`

A small standalone script, `src/widget/widget.ts`, plain TypeScript with no React or other
dependency. Vite builds it as its own entry with a fixed name, `widget.js`, at the site root (no
content hash, since contractors paste the address). In development it is served at
`/widget.js` too. The PWA service worker must not answer `/widget.js` with the app's page.

When it runs on the contractor's site:

1. **Its booking address** is the origin of its own `src` (`document.currentScript`). If the
   script was already set up on this page (pasted twice), it stops.
2. **The look:** `GET <booking origin>/api/online-booking/widget?host=<booking hostname>`. With
   `open: false`, no button. If the call fails, the button shows in the default color.
3. **The button:** fixed bottom-right (16 px from the edges, above the page's safe area on
   phones), "Book online" with a calendar icon, the brand color with white or near-black text,
   whichever contrasts more. It lives in a shadow root (`attachShadow({ mode: 'closed' })`), so
   the site's CSS can't restyle it and its CSS can't leak out. A real `<button>`, with a visible
   focus ring.
4. **The popup**, on tap: a dark backdrop and the wizard in an `<iframe>` at
   `<booking origin>/?embed=1&from=widget`, titled "Book a visit". On screens 640 px and wider it
   is a centered panel up to 480 × 720 px with rounded corners; narrower, it fills the screen.
   A ✕ button sits above the frame. Escape, the ✕, or a tap on the backdrop closes it; the
   page behind doesn't scroll while it's open; focus moves into the popup and back to the button
   on close. The iframe is created on the first tap, not on page load.
5. **Messages:** it listens for `message` events whose `origin` is the booking origin and whose
   data is exactly `'relay:close'`, and closes the popup. Everything else is ignored.

### The wizard in embed mode

`BookingFlow` reads `?embed=1` and `?from=` once, like `?offer=`.

- `from`: kept only if it is `google` or `widget`; anything else is ignored. Stored in the
  answers (and so in the draft) as `bookedVia`, and sent with the booking.
- `embed=1`, and the page is really in a frame (`window.top !== window.self`):
  - The exit ("leave without booking?") posts `'relay:close'` to `window.parent` (target origin
    `'*'`, since the contractor's site can be anywhere; the message carries nothing else)
    instead of leaving to the contractor's site.
  - The booked screen's last button reads "Done" and posts `'relay:close'`.
  - The shell's link back to the contractor's site is hidden.
- `embed=1` outside a frame changes nothing.

### Framing guard

Only the booking page (`/`) and the manage page (`/manage/:token`) may be shown inside another
site. Every other route (sign-in, staff, technician, admin, `/widget-preview` included) checks
`window.top !== window.self` on render and, when framed, shows only
"Relay can't be shown inside another site." with a link that opens the same address in a new tab
(`target="_blank" rel="noopener"`). This is a script guard because the hosting configuration isn't
in the repo; when deployment config is added, the hosting should also send
`Content-Security-Policy: frame-ancestors 'self'` on every path except `/`, `/manage/*` and
`/widget.js` (noted in `docs/` as a deploy to-do).

### Where the booking came from

Beside the job's source badge (`dispatch/labels.ts`, `SOURCE`), on the dispatch board's job
details and on the job page: "· from Google" or "· from your website" when `bookedVia` is set.

## Errors

| Case | Result |
|---|---|
| Widget endpoint, unknown host | 404; the script shows no button |
| Widget endpoint, suspended contractor | `open: false`; no button |
| Widget endpoint unreachable | button in the default color; the popup's wizard shows its own errors |
| `bookedVia` not `google`/`widget` on a booking | 400 `validation_error` |
| `?from=` something else | ignored, booking has no `bookedVia` |
| Staff page loaded in a frame | the "can't be shown inside another site" notice |
| Clipboard refused | text selected, toast "Press Ctrl+C to copy" |

## Tests

API (`relay-api`):
- `GET /settings/booking-links`: subdomain URLs; verified custom domain used; unverified one
  not; `bookingOpen: false` when suspended; needs sign-in.
- `GET /online-booking/widget`: brand color and `open: true`; default color with no branding;
  `open: false` when suspended; 404 for an unknown host; `Access-Control-Allow-Origin: *` on a
  request from an outside origin, without credentials.
- Booking with `bookedVia: 'google'` and `'widget'` stores it; with none stores null; with
  `'facebook'` is a 400.
- A draft saved with `bookedVia: 'google'`, then booked from its token without `bookedVia`,
  stores `'google'`.

Web (`relay-web`):
- Reading `?from=`: `google` and `widget` kept, anything else dropped.
- Embed mode: exit and Done post `'relay:close'` when framed; nothing changes when not framed.
- The framing guard: a staff route renders the notice when framed; `/` and `/manage/:token`
  don't.
- `widget.ts`: builds the button once even when loaded twice; ignores messages from other
  origins or with other data; no button when `open: false`.

Browser check with the user: paste the snippet into the demo `contractor-site`
(`http://localhost:5173`, a different origin from `desert.localhost:5173`), open the popup at
375 px and on a computer, book through it, see "from your website" on the dispatch board; open
`/?from=google` and book, see "from Google"; load `/dashboard` in a frame and see the notice.

## Build order

1. API: `booked_via` column and migration, `bookedVia` on bookings and drafts, job responses.
2. API: `GET /settings/booking-links` and `GET /online-booking/widget` (with its CORS).
3. Web: `?from=` and `bookedVia` in the wizard and drafts; the badge text.
4. Web: embed mode and the framing guard.
5. Web: `widget.js` (build entry, dev serving, service-worker exclusion).
6. Web: the "Share your booking page" card and `/widget-preview`.
7. Browser check with the user.
