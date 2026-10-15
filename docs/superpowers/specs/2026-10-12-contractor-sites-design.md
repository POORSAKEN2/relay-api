# Contractor websites: one template, filled from Relay

Date: 2026-10-12. Status: draft, waiting for review. Build after the MVP core modules.
Repos: `relay-api`, `relay-web`, and the `contractor-site` folder (retired by this work).
Builds on: `2026-10-05-booking-widget-design.md` (booking link and widget stay as they are),
`2026-10-03-contractor-lifecycle-design.md` (a suspended contractor's public pages are off).

## Problem

Many of the shops Relay will pilot with have no website, or an old one they can't edit. Relay
only has `contractor-site/`: three hand-written static files for the demo contractor, Desert
Breeze Air, with every phone number, hour and review typed into `index.html`. Using that for
real contractors means one copy of the folder per contractor, and every "change my hours" means
someone at Relay edits the files and redeploys. That doesn't scale past a handful of shops.

## Goal

Every contractor can have a one-page marketing website that Relay hosts. The contractor picks
one of three designs and edits the content in the Relay dashboard. Edits are live on the next
page load. Nobody redeploys anything for a content change; a design change is one relay-api
deploy that updates every site.

Done means: Desert's owner opens **Website** in the dashboard, edits the headline, adds a
review and a photo, switches design, presses Publish, and `https://desert.site.garified.com`
shows the result on a phone, with Call ringing Desert's Relay number and Book online opening
Desert's booking page.

## Decisions

Made while brainstorming on 2026-10-12:

- **Relay hosts the site** (not "demo only", not one hand-built site per contractor).
- **Contractors edit content and choose between 3 designs.** They don't edit layout.
- **Address: a free subdomain first**, `<slug>.site.garified.com`. The contractor's own domain
  comes later and is designed for, not built.
- **Server-rendered by relay-api** from the database on each request. Rejected: publishing
  static files to a CDN (more moving parts than a few pilot shops need) and a React page in
  relay-web (search engines and link previews in texts and chat apps see an empty page).

## Addresses

| Page | Address | Served by |
|---|---|---|
| Contractor website | `https://<slug>.site.garified.com/` | relay-api (new) |
| Booking page | `https://<slug>.garified.com/` (unchanged) | relay-web |
| Site styles, script, photos | `/api/site/...` on any relay-api host | relay-api (new) |

- Render: add one wildcard custom domain, `*.site.garified.com`, to the relay-api web service,
  with the DNS records Render asks for. A second wildcard certificate is needed because
  `*.garified.com` covers one subdomain level only. No cost per contractor and no DNS step per
  signup.
- `parseTenantHost()` (`middleware/tenant.ts`) already rejects deeper subdomains such as
  `desert.site.garified.com`, so the booking app and the site never claim the same host.
- A new pure function, `parseSiteHost(host, appDomain)`, returns `{ slug }` for
  `<slug>.site.<appDomain>` and `null` otherwise. When contractors can bring their own domain,
  it also returns `{ siteDomain }` and a new `sites.site_domain` column stores it. That change
  touches only this function and one query.
- Development: `http://desert.site.localhost:3000/` (browsers send `*.localhost` to this
  machine). The preview in the dashboard goes through relay-web's existing `/api` proxy.
- The site's Book online links use `tenantUrl(tenant, '/')` (`lib/tenant-url.ts`), so a
  contractor with a verified custom booking domain gets that one.

## Data

Four new tables. Everything else the site shows already exists and is read, not copied:

| Shown on the site | Comes from |
|---|---|
| Business name | `tenants.name` |
| Phone number | the contractor's `phone_numbers` row with status `active`, else `tenants.contact_phone`. Calls then go through Relay, so the AI answers missed calls. |
| Logo, favicon, brand color | newest `branding_versions` row (set by a superadmin, as today) |
| Services and prices | `services` where `archived_at` is null, by `sort_order` |
| Hours | `business_hours` |
| "Text when we're on the way" | shown only when `tenants.texting_status = 'approved'` |

Rules:

- `sites.published_at` null means the site is off. Edits are saved straight to the live row:
  there are no drafts or versions.
- Cities served are typed by hand as town names. ZIP codes (`service_area_zips`) stay for the
  booking check only.
- Reviews are typed in by the contractor (copied from Google, Yelp and so on). No review API.
- Photos live in Postgres as bytes, like `user_photos` and `branding_assets`, until file
  storage is chosen. The browser shrinks them before upload. One hero photo (a new one
  replaces the old) and up to 12 work photos. Unlike branding assets they can be deleted:
  nothing else points at them.
- No street address: city and region only. Many HVAC shops serve customers at home and keep
  their address private.

The tables (dry-run on `relay_test` on 2026-10-12; port to `src/db/schema.ts` as usual):

```sql
-- One row per contractor. No row = the contractor has never saved the site form.
create table sites (
  tenant_id uuid primary key references tenants(id),
  design text not null default 'breeze',
  published_at timestamptz,                         -- null = site is off
  headline text not null,
  intro text not null,                              -- the paragraph under the headline
  about text,                                       -- 'About us' section; hidden when null
  license_number text,                              -- 'AZ ROC #123456'; hidden when null
  city text not null,                               -- 'Phoenix'
  region text not null,                             -- 'AZ'
  cities_served text[] not null default '{}',       -- town names (ZIPs stay booking-only)
  emergency_service boolean not null default false, -- shows the 24/7 emergency band
  show_prices boolean not null default true,        -- service prices on the site
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint sites_design_valid check (design in ('breeze', 'clean', 'bold')),
  constraint sites_headline_length check (char_length(headline) between 1 and 120),
  constraint sites_intro_length check (char_length(intro) between 1 and 400),
  constraint sites_about_length check (char_length(about) <= 2000),
  constraint sites_region_format check (region ~ '^[A-Z]{2}$'),
  constraint sites_cities_served_count check (cardinality(cities_served) <= 30)
);

create table site_reviews (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  author_name text not null,                        -- 'Maria G.'
  place text,                                       -- 'Mesa'
  rating smallint not null,
  body text not null,
  sort_order smallint not null default 0,
  created_at timestamptz not null default now(),
  constraint site_reviews_rating_range check (rating between 1 and 5),
  constraint site_reviews_body_length check (char_length(body) between 1 and 600)
);

create table site_faqs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  question text not null,
  answer text not null,
  sort_order smallint not null default 0,
  created_at timestamptz not null default now(),
  constraint site_faqs_question_length check (char_length(question) between 1 and 200),
  constraint site_faqs_answer_length check (char_length(answer) between 1 and 1000)
);

create table site_photos (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  kind text not null,                               -- 'hero': one at a time; 'work': gallery
  content_type text not null,
  data bytea not null,
  alt_text text not null,                           -- read aloud by screen readers
  sort_order smallint not null default 0,
  created_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  constraint site_photos_kind_valid check (kind in ('hero', 'work')),
  constraint site_photos_content_type_valid check (content_type in ('image/jpeg', 'image/webp')),
  constraint site_photos_size check (octet_length(data) between 1 and 1048576),
  constraint site_photos_alt_text_length check (char_length(alt_text) between 1 and 200)
);

create index site_reviews_tenant_idx on site_reviews (tenant_id, sort_order);
create index site_faqs_tenant_idx on site_faqs (tenant_id, sort_order);
create index site_photos_tenant_idx on site_photos (tenant_id, kind, sort_order);
```

## Rendering

A new module, `src/modules/sites/`, following the usual layout:

- `sites.routes.ts`: mounted in `app.ts` before `/api`. If `parseSiteHost(req.hostname)` returns
  nothing, it calls `next()` and the request carries on as today. On a site host, `GET /`
  renders the page and every other path outside `/api` gets the 404 page.
- `sites.queries.ts`: `getPublicSite(tenantId)` loads the site row, reviews, FAQs, photo ids and
  the reused data in the table above. Every query takes `tenantId` first.
- `site-view.ts`: pure functions that turn those rows into what a template shows: hours as
  "Mon–Sat 7 AM–7 PM", price labels ("$89", "$129 diagnostic", "Free estimate"), the formatted
  phone and `tel:` link, the booking link, black or white text for the brand color (whichever
  passes WCAG AA contrast), which claims may appear (see below), and the JSON-LD block. No
  database, so it is unit-tested directly.
- `html.ts`: an `html` tagged template that escapes every value it is given, plus `raw()` for
  the rare trusted fragment (the JSON-LD block, after `JSON.stringify` with `<` escaped).
- `designs/breeze.ts`, `designs/clean.ts`, `designs/bold.ts`: each exports
  `render(view): string`. Plain TypeScript, so renaming a view field breaks the build, not a
  live site. No template engine dependency. Each has a CSS file next to it.

Assets are served on any relay-api host, so the same relative URLs work on the live site, in
the dashboard preview (served from the API host) and through relay-web's dev proxy:

| Path | Returns | Cache |
|---|---|---|
| `/api/site/assets/<design>.css`, `/api/site/assets/site.js` | design styles; phone menu and call bar | long, URL carries the deploy version |
| `/api/site/photos/:id` | one photo, public like `/api/branding/assets/:assetId` | `public, max-age=31536000, immutable` |
| logo and favicon | existing `/api/branding/assets/:assetId` | as today |

The page itself is sent with `Cache-Control: no-cache`, so an edit shows on reload.

### Sections

Every design shows the same sections in the same order, and hides a section with no content:

1. Header: logo, name, phone, Book online
2. Hero: headline, intro, Book online and Call, hero photo
3. Services
4. How booking works (fixed copy about Relay's booking steps)
5. Reviews
6. Work photos
7. About
8. Service area (`cities_served`)
9. Hours
10. FAQ
11. Closing call to action
12. Footer: license, city and region, hours

On phones a fixed Call / Book bar appears once the hero buttons scroll away (the behaviour in
today's `contractor-site/main.js`). Designs change the look only, so switching design never
loses content.

### Claims

Carried over from `contractor-site/PRODUCT.md`: the page states a fact only when the data backs
it.

| Claim | Shown only when |
|---|---|
| "Licensed" | `license_number` is set |
| "24/7 emergency service" | `emergency_service` is true |
| "A text when we're on the way" | `texting_status = 'approved'` |
| "Price approved before work starts" | `show_prices` is true |

### Designs

- **breeze**: today's `contractor-site` design made general. It keeps the breeze-block wall and
  drops the "Outside 112°" / "Inside 76°" readings, which are Phoenix facts.
- **clean**: light and photo-led, built around the hero photo. Suits any region.
- **bold**: dark and high-contrast, with a large phone number and the emergency band near the
  top, for shops that live on urgent calls.

Each design places the contractor's brand color in its own way. The detailed visual work for
`clean` and `bold` happens when they are built; this spec fixes their content and purpose.

## Editing in the dashboard

### API

All routes use `requireRole('owner', 'office')`, like settings. Request bodies are checked in
`sites.schemas.ts`.

| Route | Does |
|---|---|
| `GET /api/site` | content, reviews, FAQs and photo list. With no row yet, a prefilled form (headline "AC and heating repair in {city}", empty lists). |
| `PUT /api/site` | saves the main fields; the first save creates the row |
| `POST /api/site/publish` | sets `published_at`. Refused unless there is a phone to show and at least one active service. |
| `POST /api/site/unpublish` | clears `published_at` |
| `POST /api/site/reviews`, `PUT /api/site/reviews/:id`, `DELETE /api/site/reviews/:id` | reviews |
| `PUT /api/site/reviews/order` | body `{ ids }`, sets `sort_order` |
| same four for `/api/site/faqs` | FAQs |
| `POST /api/site/photos?kind=hero\|work&alt=...` | raw bytes like branding uploads; type read from the bytes (`lib/image-type.ts`). A hero upload replaces the old hero. |
| `DELETE /api/site/photos/:id` | removes a photo |
| `GET /api/site/preview` | the page rendered with the same `render()`, even while the site is off |

Register the `/order` routes before the `/:id` routes, so "order" is never read as an id.
Every change writes an `audit_events` row, as other settings do.

### Page

`relay-web/src/features/site/`, reached from a **Website** item in settings:

- **Status card**: Off or Live, the address with Copy and Open, and Publish or Unpublish.
- **Design picker**: three cards with screenshot thumbnails (static images in `public/`).
- **Basics, Reviews, FAQ, Photos**: one block each with its own Save. Reviews and FAQs reorder
  with up and down buttons.
- **Reused data**: read-only lines pointing to where it is edited: "Services and prices come
  from Catalog", "Hours come from Schedule", "Logo and color are set by Relay".
- **Preview**: an iframe of `/api/site/preview` next to the form on desktop, behind a Preview
  button on phones. It reloads after each save. The session cookie reaches the API because
  `<slug>.garified.com` and `api.garified.com` are the same site.

## Errors

- **Site not shown** (plain 404 page with no contractor details, so it doesn't reveal whether a
  contractor exists): unknown slug, no `sites` row, `published_at` null, or the tenant is
  `suspended`. A suspended site comes back by itself when the tenant is active again. A tenant
  in `setup` may publish, so a shop can see its site live before booking opens.
- **Bad form input**: 400 with the usual `{ error: { code, message, details } }`; the form marks
  the field.
- **Bad photo**: 400, "Photos must be JPEG or WebP, up to 1 MB".
- **Database failure while rendering**: 500 to Sentry as today; the visitor gets a bare "Try
  again in a minute" page with no stack trace.

## Retiring contractor-site

Once the module ships:

- The `breeze` design takes its markup and CSS from `contractor-site/`.
- `src/db/seed.ts` gives Desert a published `sites` row with today's copy, reviews (still
  labeled as samples) and FAQ, so the demo lives at `http://desert.site.localhost:3000/`.
- Delete `contractor-site/` and the `contractorSite()` dev plugin in `relay-web/vite.config.ts`,
  and update both READMEs. Plain `localhost:5173` then shows the app's usual "Contractor not
  found".

## Tests

Vitest on `relay_test`, as the other modules do.

- `site-view.test.ts` (pure): hours with a closed day, a split week and every day open; price
  labels for `fixed`, `diagnostic` and `free`, and none when `show_prices` is false; black or
  white text on a light and a dark brand color; each claim hidden when its data is missing;
  the JSON-LD block.
- `html.test.ts`: escapes `<`, `>`, `&`, `"` and `'`, including inside attributes.
- `site-host.test.ts`: `parseSiteHost` on `desert.site.garified.com`, uppercase, with a port,
  `garified.com`, `desert.garified.com`, `a.b.site.garified.com`, `api.garified.com`.
- `sites.test.ts` (HTTP): a site host gets the page and other hosts fall through; each 404
  case above, including a suspended tenant; `desert` can't read or change `other`'s site,
  reviews or photos; publish refused with no services; photo type, size and count limits; a
  new hero replaces the old one; owner and office allowed, technician gets 403.
- `designs.test.ts`: each design renders Desert's seed content and contains the phone link,
  the Book link and every non-empty section. Content checks, not pixels.
- Browser check before calling it done (headless Edge): each design at 375 px and 1280 px,
  and the edit, preview and publish loop in the dashboard.

## Out of scope

- The contractor's own domain (planned for in Addresses).
- File storage for photos.
- More than one page, a blog, or a contact form. Call and Book online are the only actions.
- Visit counts and other stats.
- SEO work beyond the title, meta description and JSON-LD block.
- Reviews pulled from Google or any other API.
- Drafts, scheduled publishing or version history.
- Contractors editing their own logo or colors.
