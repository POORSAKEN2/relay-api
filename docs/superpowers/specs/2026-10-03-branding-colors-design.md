# Brand colors: hex code input and a contrast warning with a suggested shade

Date: 2026-10-03. Status: draft. Branch: `feat/branding-colors` in both repos (the spec lives
in relay-api, the code is in relay-web), on top of `feat/branding-history`.

Tasks #3 ("Hex code input next to the color picker") and #5 ("Contrast warning that suggests
a darker or lighter shade") of the white-label admin list. Web only: no API change.

## Problem

- The color form on a contractor's admin card has only the browser's color picker. The
  superadmin can't type or paste a contractor's exact brand code (for example from their
  style guide), and can't see the code that is set.
- Nothing warns when a color is hard to read. The primary color is drawn as **text and
  icons on the white page**: links, the active item in the staff sidebar, the booking step
  icons and status text. A light primary (yellow, light blue, light green) makes these hard
  to read.

## Goal

1. Each color has a hex text box next to its picker. Typing a valid code updates the picker,
   and picking a color updates the box.
2. Under the primary color, a warning appears when it is hard to read as text on white, with
   a one-click suggestion of the closest shade of the same color that passes.
3. The warning is advice: a low-contrast color can still be saved.

## Out of scope

- **Checking the accent color.** It is not drawn on the page as text, icons or outlines
  anywhere yet; where it is a background, its text is chosen automatically (black or white).
  Checking it against white would warn on Relay's own default accent (`#0ea5e9`, 2.77:1).
  Revisit when the live preview (#4) or new screens put the accent on the page.
- Text on brand-colored backgrounds (buttons, the booking header). It already picks black or
  white automatically, and the better of the two always reaches at least 4.58:1.
- Dark mode. The app has a dark theme in its CSS but never turns it on.
- A copy button for the hex code. The text box can be selected and copied.
- Checking colors in the "Generate palette" button. Its result goes through the same warning.

## Hex input (#3)

`ColorField` in `features/branding/branding-form.tsx` gets a text box after the color picker:

- Label: visually the same field ("Primary color" / "Accent color"); the text box has
  `aria-label="Primary color hex code"` / `"Accent color hex code"`. Monospace, about 7
  characters wide, `spellCheck={false}`, `autoComplete="off"`.
- Accepted while typing, with or without `#`, any case: `rrggbb` or the short form `rgb`.
  As soon as the box holds a valid code, the picker updates to it.
- On leaving the box (blur), a valid value is rewritten in the canonical form `#rrggbb`
  (lowercase, short form expanded: `#16A` → `#1166aa`). An invalid value stays as typed and
  shows the existing message "Use a hex color like #1d4ed8" under the field.
- Moving the picker rewrites the box with the picker's value.
- Submitting the form uses the canonical value. If either box is invalid, Save shows the
  same message and does not send (the existing zod check in `BrandingInput` stays the final
  gate).
- When the saved colors change from outside the form (a restore), both the picker and the
  box follow them, as the color inputs already do.

## Contrast warning (#5)

### What is checked

The primary color against the white page background (`#ffffff`), for normal-size text: WCAG
2.x AA, **at least 4.5:1**. The contrast ratio uses the WCAG 2.x relative luminance formula,
the same one `readableTextColor` already uses.

Examples (on white): `#1d4ed8` (Relay's default) 6.70:1, passes. `#38bdf8` 2.14:1,
`#facc15` 1.53:1, `#22c55e` 2.28:1, `#777777` 4.48:1 — all warn.

### The suggestion

`suggestShade(hex, background, minRatio)`:

- Returns `null` when `hex` already reaches `minRatio`.
- Otherwise converts the color to HSL, keeps hue and saturation, and moves lightness away
  from the original in steps of 0.5 percentage points, trying darker and lighter at each
  distance (darker first), until a shade reaches `minRatio`. It returns the first one found:
  the passing shade closest in lightness to the original.
- Returns `null` if no shade passes (cannot happen for 4.5:1 on white, since black passes,
  but the function must not loop or throw).
- On a white background the passing shade is always darker in practice; the function is
  written for any background so the same code serves the live preview later.

Examples on white at 4.5:1: `#38bdf8` → about `#067baf`, `#facc15` → about `#8c7103`,
`#22c55e` → about `#178841`. Exact values come from the 0.5-point steps.

### What the admin sees

Only while the primary box holds a valid color that fails:

> ⚠ Hard to read as text on white (2.1:1, needs 4.5:1). **[Use #067baf]**

- The ratio is shown with one decimal, rounded down, so a color is never shown as "4.5:1"
  while failing.
- The text uses the app's warning style (`text-amber-700`, with an icon), inside an element
  with `role="status"` so screen readers announce it when it appears.
- The button shows a small swatch of the suggested shade. Clicking it sets the picker and the
  box to that shade. Nothing is saved until Save.
- The warning disappears as soon as the color passes.

## Code

- New `features/branding/color.ts`, pure and dependency-free:
  - `normalizeHex(input: string): string | null` — `#rrggbb` lowercase, or `null`.
  - `relativeLuminance(hex: string): number` and `contrastRatio(a: string, b: string): number`.
  - `suggestShade(hex: string, background: string, minRatio: number): string | null`.
  - The HSL conversions it needs (not exported unless a test needs them).
- `apply-branding.ts`: `readableTextColor` uses `contrastRatio` from `color.ts` instead of its
  own copy of the formula. Its results must not change.
- `branding-form.tsx`: `ColorField` gains the hex box; the form renders the warning under the
  primary field. A small `ContrastWarning` component may live in the same file or its own.
- `PRIMARY_MIN_CONTRAST = 4.5` is a named constant in `color.ts`.

## Testing

`color.test.ts` (node, as the other web tests):

- `normalizeHex`: `#1d4ed8`, `1D4ED8`, `#16a`, `16A`, ` #1d4ed8 ` (spaces trimmed) all give
  canonical values; `#1d4ed`, `#gggggg`, `red`, `` and `#1d4ed8ff` give `null`.
- `contrastRatio`: black on white is 21 (to 2 decimals); white on white is 1; it is
  symmetric; `#777777` on white is 4.48 (to 2 decimals).
- `suggestShade`: `null` for `#1d4ed8` on white at 4.5; for `#38bdf8`, `#facc15` and
  `#22c55e` the result reaches 4.5:1 and keeps the original hue within 2 degrees; the result
  is the closest passing lightness (one step less change does not pass); on a black
  background a dark color gets a lighter suggestion; a call that cannot pass returns `null`.
- The existing `readableTextColor` tests still pass unchanged.

No component tests (relay-web has no setup for them). The form is checked with typecheck,
lint and a manual run: type a short code, see the picker move; pick a light yellow, see the
warning, click the suggestion, save.
