# Logo and favicon: let the superadmin upload a contractor's logo and favicon

Date: 2026-10-03. Status: draft. Plan: `docs/superpowers/plans/2026-10-03-branding-logo-favicon.md`.

Sub-project 2 of the white-label admin work. It is built on top of the contractor lifecycle
work (`feat/contractor-lifecycle`), on branch `feat/branding-assets` in both repositories.

## Problem

`branding_versions` has `logo_url` and `favicon_url` columns, but nothing sets them. Every
contractor's booking page and staff screens show only the contractor's name, and the browser
tab always shows Relay's icon.

## Goal

1. The superadmin uploads a logo and a favicon for a contractor, as PNG or SVG, from the
   contractor's card on the admin page, and can remove either one.
2. Each upload or removal saves a new branding version. Older versions keep their images,
   so the later "revert" sub-project can restore them.
3. The logo shows in the booking page hero and in the staff sidebar header. Without a logo,
   both show the name as today.
4. The favicon shows in the browser tab on every page of the contractor's site. Without one,
   Relay's icon stays.

## Out of scope

- Cropping, resizing or converting images. The admin uploads a file that is ready to use.
- ICO, JPEG or WebP files. Only PNG and SVG.
- Logo on the technician job page and in emails. Those come with their own sub-projects.
- The PWA install icon and manifest (`vite.config.ts`). It stays Relay's.
- Moving files to object storage (S3, R2). Assets move together with photos when that
  happens.
- Using the logo as a fallback favicon.

## Data

### `branding_assets` (new)

Uploaded images live in Postgres, like technician and booking photos. They are small, and
this needs no new service, keys or local setup.

| Column | Meaning |
| --- | --- |
| `id`, `tenant_id` | As everywhere. `unique (tenant_id, id)` so versions can reference it with the tenant. |
| `kind` | `logo` or `favicon` (`BRANDING_ASSET_KINDS`). |
| `content_type` | `image/png` or `image/svg+xml` (`BRANDING_ASSET_TYPES`), read from the bytes, never from the upload's header. |
| `data` | The file bytes (`bytea`). |
| `created_by` | The superadmin who uploaded it. Plain FK to `users`, like `branding_versions.created_by`. |
| `created_at` | As everywhere. |

Rules:

- Size: a logo is at most 512 KB (`LOGO_MAX_BYTES`), a favicon at most 100 KB
  (`FAVICON_MAX_BYTES`). A check constraint keeps `data` between 1 byte and 512 KB, and the
  service checks the per-kind limit.
- Rows are never updated or deleted. A removed logo stays in the table because older
  versions still point at it.

### `branding_versions` changes

- New columns `logo_asset_id` and `favicon_asset_id` (nullable uuid). Each has a foreign key
  `(tenant_id, …_asset_id)` → `branding_assets (tenant_id, id)`, so a version can only use its
  own contractor's images.
- `logo_url` and `favicon_url` are dropped. Nothing ever wrote them, so they are null in every
  database. The API response keeps the names `logoUrl` and `faviconUrl` and builds them from
  the asset ids.
- Migration `0009` creates the table, adds the columns and foreign keys, and drops the two
  old columns.

The kind is not enforced by the foreign key: the service only ever puts a `logo` asset in
`logo_asset_id` and a `favicon` asset in `favicon_asset_id`.

## Accepted files

The type is read from the bytes (`brandingAssetTypeOf` in `lib/image-type.ts`):

- **PNG:** starts with the PNG signature (`89 50 4E 47 0D 0A 1A 0A`).
- **SVG:** after an optional UTF-8 BOM and whitespace, the text starts with `<svg` or `<?xml`,
  and contains `<svg`. The bytes must be valid UTF-8.
- Anything else is refused with `400 unsupported_image`, "Use a PNG or SVG file."

An SVG can carry scripts and links. It is refused with `400 unsafe_svg`, "This SVG has scripts
or links in it. Export it again as a plain SVG.", when its text (case-insensitive) contains
any of:

- `<script`
- `<foreignObject`
- an event attribute: `on` + letters + optional spaces + `=` (e.g. `onload=`)
- `javascript:`
- an `href` or `xlink:href` whose value doesn't start with `#` or `data:image/`

An empty body gets `400 unsupported_image`. A file over the kind's limit gets
`400 image_too_large`, "The logo must be 512 KB or smaller." or "The favicon must be 100 KB or
smaller." The size is checked before the type.

This check is defense in depth, not the main protection. The main protection is how assets
are served and shown (next sections): only through `<img>` and `<link rel="icon">`, where
browsers never run scripts, and with a sandbox policy when opened directly.

## API

### Upload and remove (superadmin, `modules/branding`)

| Route | Body | Does |
| --- | --- | --- |
| `PUT /api/admin/tenants/:tenantId/branding/logo` | the file, raw | stores the asset, saves a new version with it as the logo |
| `PUT /api/admin/tenants/:tenantId/branding/favicon` | the file, raw | the same for the favicon |
| `DELETE /api/admin/tenants/:tenantId/branding/logo` | none | saves a new version without a logo |
| `DELETE /api/admin/tenants/:tenantId/branding/favicon` | none | the same for the favicon |

- The body is read with `express.raw({ type: () => true, limit: '1mb' })`, like photo
  uploads. A larger body gets Express's `413`, shown by the web app as its message.
- Every route needs `requireRole('superadmin')` and answers `404 not_found` for an unknown
  contractor.
- A new version copies the latest version's colors and the other asset, so uploading a logo
  never changes the favicon or the colors. With no earlier version, the colors are
  `DEFAULT_COLORS`.
- The asset insert, the version insert and an audit event run in one transaction. The audit
  actions are `branding.logo_updated`, `branding.logo_removed`, `branding.favicon_updated` and
  `branding.favicon_removed`, entity type `tenant`, data `{ assetId }` (or `{}` on removal).
- Removing when there is no logo still saves a version and returns `200`. That keeps the
  route simple, and history shows the click.
- After saving, the route emits `branding.updated` to the tenant (as color changes do) and
  returns the branding, in the same shape as `GET /api/admin/tenants/:tenantId/branding`.
- Saving colors (`PUT …/branding`) now copies `logo_asset_id` and `favicon_asset_id` forward.

### Serving (public)

`GET /api/branding/assets/:assetId` sends the asset's bytes. It needs no sign-in and no
`X-Tenant-Host`, because `<img>` and favicon requests can't send headers. Asset ids are
random UUIDs.

Headers:

- `Content-Type`: the stored type.
- `X-Content-Type-Options: nosniff`
- `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`. If
  someone opens an SVG's URL directly, nothing in it runs or loads.
- `Cache-Control: public, max-age=31536000, immutable`. An asset's bytes never change.
- `Cross-Origin-Resource-Policy: cross-origin`. The web app on `<slug>.garified.com` loads
  it from the API's host.

It answers `404 not_found` for an unknown or malformed id. It serves an asset whatever the
contractor's status: a turned-off contractor's pages already don't load, and the image alone
reveals nothing.

### Branding response

`logoUrl` and `faviconUrl` are paths under the API, like a technician's `photoUrl`:
`/branding/assets/<id>`, or `null`. The web app puts its API address in front.

## Web

### Admin card (`features/branding`)

Below the color pickers, the contractor's card gets two rows, "Logo" and "Favicon". Each has:

- a preview: the current image on a checkered background, or "None" in muted text;
- "Upload" (a file input, `accept="image/png,image/svg+xml"`) and "Remove" (only when one is
  set);
- the error under the row when an upload fails, from `uploadErrorMessage` (see Testing): the
  API's message for `unsupported_image`, `unsafe_svg` and `image_too_large`, and the same
  too-large message for Express's `413`.

A successful upload or removal updates the card and shows a toast ("Logo updated", "Logo
removed", "Favicon updated", "Favicon removed"). The upload is the file itself, sent raw with
its `Content-Type`. Nothing is resized in the browser.

### Booking page (`features/booking/booking-shell.tsx`)

With a logo, the hero shows it above the "Book with …" heading: `max-h-14`, `max-w-48`,
`object-contain`, with `alt` set to the contractor's name. Without a logo, nothing changes.

### Staff sidebar (`components/sidebar.tsx`)

- Expanded, with a logo: the header shows the logo (`max-h-8`, `max-w-full`,
  `object-contain`, `alt` = name) instead of the name text.
- Collapsed, with a logo: the logo inside the existing 32 px square, `object-contain`.
- Without a logo: as today.

The header stays brand-colored, and the logo is shown as uploaded. Picking a logo that reads
well on the primary color is the admin's job; the preview shows it on the checkered
background only.

### Favicon (`components/app-layout.tsx`)

When the branding has a `faviconUrl`, `AppLayout` points every `<link rel="icon">` in the
document at it, and removes the `sizes` and `type` attributes so the browser uses it. When
the contractor has none, or after navigating to a host without one, the links get back their
original `href`, `sizes` and `type` from `index.html`. AppLayout reads the originals once,
on first run. The decision sits in a pure function, `faviconLinks(originals, faviconUrl)` in
`features/branding/favicon.ts`: it returns the attributes each link should have, and a thin
effect applies them, so it can be tested without a DOM.

The `apple-touch-icon` stays Relay's.

## Testing

API:

- `lib/image-type.ts`: PNG and SVG detection (with and without the XML prolog and a BOM),
  non-UTF-8 text, a JPEG refused, and every unsafe-SVG pattern refused while a plain SVG with
  `#` and `data:image/` references passes.
- Upload: PNG and SVG logo and favicon create an asset and a new version; the colors and the
  other asset are kept; the audit event is written.
- Errors: unsupported type, unsafe SVG, too large per kind, empty body, unknown contractor
  `404`, non-superadmin `403`, signed out `401`.
- Remove: a new version without the asset, the other asset kept; works with nothing set.
- Saving colors keeps the logo and favicon.
- Serving: the right bytes, type and every header listed; `404` for an unknown id and for a
  malformed id.
- The branding response gives `/branding/assets/<id>` paths.
- The asset foreign key refuses another contractor's asset (a direct insert in the test).

Web (node environment, logic only, as in the contractor lifecycle work):

- `faviconLinks`: with a URL, every link gets that `href` and no `sizes` or `type`; with
  `null`, every link gets its original attributes back.
- `uploadErrorMessage(error, kind)` in `features/branding/upload-error.ts`: a `413` gives the
  kind's too-large message ("The logo must be 512 KB or smaller."); any other error gives
  `errorMessage(error)`, which already shows the API's own message for a `400`.
