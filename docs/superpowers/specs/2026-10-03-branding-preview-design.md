# Branding preview: see the booking page and dashboard in the draft colors before saving

Date: 2026-10-03. Status: draft. Branch: `feat/branding-preview` in both repos (the spec lives
in relay-api, the code is in relay-web), on top of `feat/branding-colors`. Web only: no API
change.

Task #4 of the white-label admin list ("Live preview of the booking page, dashboard, job page
and emails"), scoped down to the two surfaces that exist (see Out of scope).

## Problem

The superadmin picks a contractor's colors on the admin card, but only sees what they look
like after saving and opening the contractor's site. An ugly or unreadable combination is
found late, and every trial save adds a branding version to the history.

## Goal

1. A **Preview** button below the Favicon row opens a large modal showing the contractor's
   **booking page** and **staff dashboard** in the colors being edited.
2. It always shows the current draft colors: typing a hex code, moving a picker, using a
   suggested shade, "Generate palette", or a restore. Nothing has to be saved.
3. The preview is built from the same components as the real pages, so it can't drift from
   them, and it changes nothing else on the admin page.

## Out of scope

- **Job page and email previews.** The technician job page is still a placeholder in relay-web
  and no email is sent yet. Each gets a preview tab when it is built (the jobs module, and
  task #9 for email), so the preview shows the real design, not a guess.
- Previewing a logo or favicon before uploading. Uploads save immediately; the preview shows
  the saved logo.
- Dark mode, a phone-size toggle, and a full-page preview.
- Previewing the favicon (it only shows in a browser tab).

## How the preview gets the draft colors

The theme uses Tailwind v4 `@theme inline`, so classes such as `bg-primary` and `text-primary`
read the CSS variables (`--primary`, `--primary-foreground`, `--brand-accent`,
`--brand-accent-foreground`) directly. Setting those variables on one element recolors
everything inside it and nothing outside it.

- New pure function `brandingVars({ primaryColor, accentColor })` in
  `features/branding/apply-branding.ts` returns those four variables, with each foreground
  from `readableTextColor`.
- `applyBranding` (the live site, on `<html>`) sets the variables from `brandingVars`, so the
  site and the preview follow one rule. Its behavior must not change.
- The preview container sets the same variables as an inline `style` from the draft colors.

The draft colors are the form's last valid colors (the values the pickers show), so a
half-typed hex code never breaks the preview. The name and logo come from the saved branding.
Because the Preview button sits outside the color form, `BrandingForm` reports its draft colors
through an optional `onDraftChange(colors)` prop (called when either color changes, including on
mount). The contractor's card keeps them and passes them to the preview, falling back to the
saved colors.

## Shared pieces (refactor, no visible change to the real pages)

| Piece | Extracted from | Used by |
| --- | --- | --- |
| `BookingHero({ name, logoUrl, onExit? })` in `features/booking/booking-hero.tsx` | The `<header>` of `BookingShell` (logo, "Book with …" heading, intro line, exit button) | `BookingShell` (with `useBranding()` data) and the preview |
| `SidebarBrand({ name, logoUrl, collapsed })` in `components/sidebar-brand.tsx` | The brand-colored header block of `Sidebar` | `Sidebar` and the preview |
| `navItemClass({ active, collapsed })` in `components/sidebar-links.ts` | The `NavLink` className function of `Sidebar` | `Sidebar` and the preview's static nav items |
| `LINKS`, moved to `components/sidebar-links.ts` | `Sidebar` | The preview's nav list |

`BookingShell` keeps its exact markup and behavior (`Book a visit` while branding loads, the
exit button only when `onExit` is given). `Sidebar` keeps its collapsed and expanded states.
`PriorityNotice` in `features/booking/priority-notice.tsx` is extracted from `time-step.tsx` the
same way. Existing presentational pieces are reused as they are: `Panel`, `ChoiceCard` and
`BookingProgress` from the booking wizard, `JobCard` from the dispatch board, and `Button`.

## The Preview modal (`features/branding/branding-preview.tsx`)

(First built inline under the pickers; changed to a modal at the user's request after review.)

- On the contractor's card, between the Logo/Favicon rows and History: an outline "Preview"
  button with an eye icon and the hint "See the booking page and dashboard in these colors."
- It opens a large modal (the existing `Dialog`): up to `sm:max-w-5xl` wide and `90dvh` high,
  scrolling inside; full width minus 2rem on phones. Title "Preview: <name>", with the two tabs,
  "Booking page" and "Dashboard", in the header. Booking page is shown each time it opens. The
  tabs are plain buttons with `aria-pressed` (no new UI dependency). It closes with the X,
  Escape or a click outside.
- In the modal body, a bordered, rounded frame with a light page background (`bg-muted/40`,
  `overflow-hidden`) filling the modal's width, not height-clipped. The draft-color variables
  are set on this frame (the dialog renders in a portal, so they must not be set on the card).
- The frame has `role="img"` and `aria-label="Preview of <name>’s <surface>"`, so screen readers
  hear one description instead of sample content. An inner wrapper inside it is `inert`, so the
  fake buttons can't be focused or clicked. (`inert` must not sit on the labelled element itself:
  it removes that element from the accessibility tree.)

### Booking page tab

Top to bottom, at the real page's sizes:

1. `BookingHero` with the contractor's name and saved logo, no exit button.
2. Overlapping the hero's bottom edge (as on the real page): `BookingProgress` on step 1
   ("Service", matching the question); then a `Panel` with the question "What do you need?",
   three `ChoiceCard`s, "Repair", "Maintenance" (selected) and "New system", the
   `PriorityNotice` (the real page's accent-colored PRIORITY note, so accent changes show), and
   a full-width primary `Button` "Continue".

### Dashboard tab

A two-column mock of the staff screen:

1. Left, 15rem wide on the page background, like the real staff sidebar: `SidebarBrand` (expanded) and the nav list from `LINKS` rendered with
   `navItemClass`, "Dispatch" active and the others inactive. No user block or sign-out.
2. Right, on the real content area's `bg-muted/40`: the title "Dispatch" (as `StaffPage` shows it), a primary `Button` "Book job", and
   two `JobCard`s from a fixed sample (`PREVIEW_JOBS`: one scheduled and assigned, one priority
   and unassigned), with a no-op `onOpen`.

Sample content lives in `features/branding/preview-samples.ts` and satisfies the real types
(`BoardJob`), so a change to those types breaks the build instead of the preview.

## Testing

- `apply-branding.test.ts`: `brandingVars` gives the four variables for a pair of colors, with
  the foregrounds `readableTextColor` picks (for example `#1d4ed8` → white text, `#facc15` →
  black text); the existing `readableTextColor` tests still pass unchanged.
- relay-web has no component tests, so the refactor and the preview are checked with
  typecheck, lint, the existing suite, and a manual run:
  - the real booking page and staff sidebar look exactly as before (both sidebar states);
  - the Preview button sits below the Favicon row; after typing a hex code, moving a picker,
    using a suggested shade, "Generate palette" or a restore (without saving), the modal shows
    those colors, and nothing outside the preview frame changes color;
  - both tabs are fully visible in the modal; Escape, the X and a click outside close it;
  - the Dashboard tab shows the logo or name in the sidebar header and "Dispatch" highlighted;
  - Tab cannot move focus into the preview frame.
