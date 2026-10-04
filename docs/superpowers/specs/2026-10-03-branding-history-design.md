# Branding history: see past branding versions and restore one

Date: 2026-10-03. Status: built (written after the build, from the design approved in chat).
Branch: `feat/branding-history` in both repos, on top of `feat/branding-assets`. No plan
document: this was a bounded change to the existing branding versions.

Task #6 of the white-label admin list ("Revert to the previous branding version").

## Problem

Every branding change already saves a new row in `branding_versions`, but the admin page only
shows the latest. A superadmin who saves the wrong colors or logo has no way to go back except
re-entering the old values by hand.

## Goal

1. The contractor's card on the admin page shows a history table of recent branding versions.
2. Any older version can be restored with one click.
3. Restoring never rewrites history: it saves a **new** version with the chosen version's
   colors, logo and favicon. History only grows, so a restore can itself be undone.

## Out of scope

- Comparing two versions side by side.
- Naming or annotating versions.
- Deleting history, or paging past the 20 most recent versions.
- An audit event for color saves (they had none before this change either).

## API (`modules/branding`, superadmin only)

### `GET /api/admin/tenants/:tenantId/branding/versions`

`200 { versions: [...] }`, newest first, at most 20 (`HISTORY_LIMIT`), only this contractor's.

```json
{ "id": "…", "primaryColor": "#111111", "accentColor": "#222222",
  "logoUrl": "/branding/assets/<id>", "faviconUrl": null,
  "createdAt": "2026-10-03T14:14:00.000Z", "createdByName": "Relay Admin", "current": true }
```

- `logoUrl` / `faviconUrl`: a path under the API (as in the branding response), or `null`.
- `createdByName`: the saving user's name (join on `users`).
- `current`: true only for the newest version.
- Unknown contractor: `404 not_found` "Contractor not found". No versions: `{ versions: [] }`.
- Order is `created_at desc` with no tiebreaker. Each version is saved in its own transaction,
  so timestamps differ in practice.

### `POST /api/admin/tenants/:tenantId/branding/versions/:versionId/restore`

- The version is looked up with **both** the contractor id and the version id, so another
  contractor's version is indistinguishable from a missing one: `404 not_found` "Branding
  version not found". Unknown contractor: `404` "Contractor not found". Malformed ids:
  `400 validation_failed` (`VersionParams`).
- In one transaction: insert a new version with the restored version's `primary_color`,
  `accent_color`, `logo_asset_id` and `favicon_asset_id`, `created_by` = the superadmin; and
  write the audit event `branding.restored` (entity type `tenant`, entity id the contractor,
  data `{ versionId }`).
- Then emit `branding.updated` to the contractor's open dashboards and return the branding
  (same shape as `GET /api/admin/tenants/:tenantId/branding`).
- Restoring the current version is allowed and simply saves another identical version.

## Web (`features/branding`)

### History table (`branding-history.tsx`)

An inline table under the Logo and Favicon rows of the contractor's card, with the heading
"History". An inline table was chosen over a modal so the restored colors and logo are visible
on the same card right away.

| Column | Content |
| --- | --- |
| Colors | Two 16 px swatches, primary then accent, each with its hex value as a tooltip. |
| Logo | A thumbnail 24 px high (`alt=""`), or "No logo". |
| Saved | "Oct 3, 2:14 PM · Relay Admin" (`savedLabel`, in the browser's time zone). |
| (Action) | "Current" badge on the newest row; a "Restore" button on every other row. |

- Shows the 5 most recent rows (`HISTORY_PREVIEW`); "Show all (N)" / "Show fewer" when there
  are more.
- Loading: "Loading history…". Empty: "No changes saved yet.". Load error: the error message.
- Restore asks no confirmation (it is undoable). While a restore is pending, every Restore
  button is disabled. Success: toast "Branding restored". Failure: toast with the error message.
- Accessibility: a screen-reader caption "Branding history", column headers with `scope="col"`.

### Keeping the card in step

- A restore writes the returned branding into the card's cache, so the color pickers, logo
  and favicon update at once. Saving colors, uploading or removing a logo or favicon, and
  restoring all refresh the history table.
- The color form keeps its inputs in local state. It now follows the saved colors whenever
  they change from outside the form (an effect on `current.primaryColor` and
  `current.accentColor`). After the admin's own save the saved colors equal the inputs, so
  nothing visibly changes and the "Saved." message stays.
  - The first version keyed the form on the saved colors instead. Review found that this
    remounted the form after every save and hid the "Saved." message, so it was replaced.

## Known limitations

- After a restore, an earlier "Saved." message from the color form can stay visible until the
  card is reloaded.
- Restore is not blocked while a color save or an image upload is still pending.
- If someone else changes the branding while the admin has unsaved color edits, the inputs
  follow the saved colors and the edits are replaced.

## Testing (as built)

API (`branding-history.test.ts`, 11 tests): newest-first listing with every field and
`current` only on the first; the 20-version limit; only the contractor's own versions; empty
list and unknown contractor; restoring colors without a logo, as a new version, leaving the
restored-from version unchanged; restoring a removed logo; the `branding.restored` audit
event; 404 for another contractor's version and a random id, 400 for a malformed id; 401 and
403 on both routes.

Web (`history.test.ts`): `visibleVersions` (collapsed to 5, all when expanded, short lists
unchanged) and `savedLabel` (`Oct 3, 2:14 PM · Relay Admin` in UTC, plain spaces).

A live run against a throwaway database confirmed listing, restoring the oldest version (its
colors back, no logo, one more version) and a 404 for an unknown version id.
