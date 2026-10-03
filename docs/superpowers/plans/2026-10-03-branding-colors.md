# Brand Colors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each brand color on the admin card gets a hex text box next to its picker. The primary color shows a contrast warning against the white page, with a one-click suggestion of the closest passing shade.

**Architecture:** A pure, dependency-free module `features/branding/color.ts` holds hex parsing, WCAG contrast, the shade search and the form's submit parsing, and has tests. `readableTextColor` reuses its contrast math. `branding-form.tsx` keeps two pieces of state, the typed hex text and the last valid color per field, and renders a `ContrastWarning` under the primary field. The change is web only.

**Tech Stack:** relay-web: React, TypeScript, Tailwind v4, shadcn/ui (Base UI), lucide-react, vitest (node environment).

**Spec:** `relay-api/docs/superpowers/specs/2026-10-03-branding-colors-design.md`

## Global Constraints

- Repo: `D:\Sen\personal\HVAC\relay-web`, branch `feat/branding-colors`. The controller creates the branch from `feat/branding-history`; never switch branches. Use the Bash tool with POSIX syntax (the machine is Windows).
- The untracked `src/features/auth/landing.test.ts` is the user's work in progress, and it already fails typecheck, lint and tests. Never edit, format, stage or delete it. Its failures don't count; any other failure does.
- Gates before each commit: `npm run typecheck`, `npx biome check --line-ending=crlf .` and `npm test`. Keep files CRLF with no BOM. Format only your own files: `npx biome check --line-ending=crlf --write <files>`.
- Commit messages end with exactly `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Use that line even if your own model name differs. Add files by path. Do not push.
- Values, copied exactly from the spec:
  - `PRIMARY_MIN_CONTRAST = 4.5`, checked against the page background `#ffffff`
  - lightness step `0.005`
  - invalid-hex message `Use a hex color like #1d4ed8`
  - warning text `Hard to read as text on white (<ratio>:1, needs 4.5:1).`, where `<ratio>` comes from `formatRatio` (rounded down to one decimal)
  - button text `Use <shade>`
  - text box `aria-label`s `Primary color hex code` and `Accent color hex code`
- Only the primary color is checked. The accent is out of scope, as the spec explains.
- No API change.

## Review Focus

1. **An invalid hex in a box, then Save.** The form must not silently send the picker's older valid value. It flags the field and doesn't send. Pinned in Task 1 (`readColorInputs`) and wired in Task 2.
2. **The short form and stray input.** `#16A` becomes `#1166aa`, surrounding spaces are trimmed, and `#1d4ed8ff` is rejected. Pinned in Task 1.
3. **A ratio just under the minimum.** `#777777` (4.48:1) must display as `4.4`, never `4.5`. Pinned in Task 1 (`formatRatio`).
4. **The `readableTextColor` refactor.** It must give the same black or white for every existing case, including the tie behaviour. Pinned by the existing `apply-branding.test.ts` in Task 1.
5. **After a restore, the hex boxes follow the restored colors**, not just the pickers. Covered by Task 2's effect and checked in the manual run.

---

### Task 1: The pure color module

**Files:**
- Create: `src/features/branding/color.ts`
- Create: `src/features/branding/color.test.ts`
- Modify: `src/features/branding/apply-branding.ts` (`readableTextColor` uses `contrastRatio`)

**Interfaces:**
- Produces, from `./color`:
  - `PRIMARY_MIN_CONTRAST`
  - `HEX_MESSAGE`
  - `ColorKey` (`'primaryColor' | 'accentColor'`)
  - `normalizeHex(input): string | null`
  - `relativeLuminance(hex): number`
  - `contrastRatio(a, b): number`
  - `formatRatio(ratio): string`
  - `toHsl(hex): [number, number, number]`, with each value in 0–1
  - `fromHsl(h, s, l): string`
  - `suggestShade(hex, background, minRatio): string | null`
  - `readColorInputs(texts)`, which returns `{ colors, errors: null }` or `{ colors: null, errors }`

- [ ] **Step 1: Write the failing tests**

Create `src/features/branding/color.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  contrastRatio,
  formatRatio,
  fromHsl,
  HEX_MESSAGE,
  normalizeHex,
  readColorInputs,
  relativeLuminance,
  suggestShade,
  toHsl,
} from './color'

const WHITE = '#ffffff'

describe('normalizeHex', () => {
  it.each([
    ['#1d4ed8', '#1d4ed8'],
    ['1D4ED8', '#1d4ed8'],
    ['#16a', '#1166aa'],
    ['16A', '#1166aa'],
    [' #1d4ed8 ', '#1d4ed8'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeHex(input)).toBe(expected)
  })

  it.each(['#1d4ed', '#gggggg', 'red', '', '#1d4ed8ff', '##1d4ed8'])('refuses %j', (input) => {
    expect(normalizeHex(input)).toBeNull()
  })
})

describe('contrastRatio', () => {
  it('is 21 for black on white and 1 for a color on itself', () => {
    expect(contrastRatio('#000000', WHITE)).toBeCloseTo(21, 2)
    expect(contrastRatio('#1d4ed8', '#1d4ed8')).toBe(1)
  })

  it('does not depend on the order', () => {
    expect(contrastRatio(WHITE, '#1d4ed8')).toBe(contrastRatio('#1d4ed8', WHITE))
  })

  it('gives #777777 on white just under 4.5', () => {
    expect(contrastRatio('#777777', WHITE)).toBeCloseTo(4.48, 2)
  })
})

describe('formatRatio', () => {
  it.each([
    [4.4799, '4.4'],
    [2.14, '2.1'],
    [6.7, '6.7'],
    [21, '21.0'],
  ])('%d → %s', (ratio, expected) => {
    expect(formatRatio(ratio)).toBe(expected)
  })
})

describe('suggestShade', () => {
  it('suggests nothing for a color that already passes', () => {
    expect(suggestShade('#1d4ed8', WHITE, 4.5)).toBeNull()
  })

  it.each(['#38bdf8', '#facc15', '#22c55e', '#777777'])(
    'gives %s the closest darker shade that passes, same hue',
    (color) => {
      const shade = suggestShade(color, WHITE, 4.5)
      expect(shade).toMatch(/^#[0-9a-f]{6}$/)
      expect(contrastRatio(shade!, WHITE)).toBeGreaterThanOrEqual(4.5)
      const [hue, saturation, lightness] = toHsl(color)
      if (saturation > 0) expect(Math.abs(toHsl(shade!)[0] - hue)).toBeLessThan(2 / 360)
      // The shade is the first passing step; one step less is not enough.
      const steps = Array.from({ length: 200 }, (_, index) => index + 1)
      const step = steps.find((n) => fromHsl(hue, saturation, lightness - n * 0.005) === shade)
      expect(step).toBeDefined()
      expect(
        contrastRatio(fromHsl(hue, saturation, lightness - (step! - 1) * 0.005), WHITE),
      ).toBeLessThan(4.5)
    },
  )

  it('suggests a lighter shade on a dark background', () => {
    const shade = suggestShade('#1e3a8a', '#000000', 4.5)
    expect(shade).not.toBeNull()
    expect(relativeLuminance(shade!)).toBeGreaterThan(relativeLuminance('#1e3a8a'))
    expect(contrastRatio(shade!, '#000000')).toBeGreaterThanOrEqual(4.5)
  })

  it('gives up with null when no shade can pass', () => {
    expect(suggestShade('#777777', WHITE, 22)).toBeNull()
  })
})

describe('toHsl and fromHsl', () => {
  it.each(['#1d4ed8', '#facc15', '#777777', '#000000', '#ffffff'])('round-trip %s', (hex) => {
    const [h, s, l] = toHsl(hex)
    expect(fromHsl(h, s, l)).toBe(hex)
  })
})

describe('readColorInputs', () => {
  it('gives canonical colors when both boxes are valid', () => {
    expect(readColorInputs({ primaryColor: '#16A', accentColor: ' 0ea5e9 ' })).toEqual({
      colors: { primaryColor: '#1166aa', accentColor: '#0ea5e9' },
      errors: null,
    })
  })

  it('flags each invalid box and gives no colors', () => {
    expect(readColorInputs({ primaryColor: '#12', accentColor: '#0ea5e9' })).toEqual({
      colors: null,
      errors: { primaryColor: [HEX_MESSAGE] },
    })
    expect(readColorInputs({ primaryColor: 'nope', accentColor: '' })).toEqual({
      colors: null,
      errors: { primaryColor: [HEX_MESSAGE], accentColor: [HEX_MESSAGE] },
    })
  })
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npm test -- src/features/branding/color.test.ts`
Expected: FAIL, because `./color` can't be resolved.

- [ ] **Step 3: Write `color.ts`**

```ts
// Colors as '#rrggbb' strings. Contrast follows WCAG 2.x.

export type ColorKey = 'primaryColor' | 'accentColor'

// The primary color is drawn as text and icons on the white page, so it needs the AA level
// for normal text.
export const PRIMARY_MIN_CONTRAST = 4.5
export const HEX_MESSAGE = 'Use a hex color like #1d4ed8'

const LIGHTNESS_STEP = 0.005

// '#1D4ED8', '1d4ed8', '#16a' → '#1d4ed8' / '#1166aa'. Anything else → null.
export function normalizeHex(input: string): string | null {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(input.trim())
  if (!match) return null
  const digits = match[1].toLowerCase()
  const full = digits.length === 3 ? [...digits].map((digit) => digit + digit).join('') : digits
  return `#${full}`
}

function channels(hex: string): [number, number, number] {
  return [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255) as [
    number,
    number,
    number,
  ]
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = channels(hex).map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  )
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrastRatio(a: string, b: string): number {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x)
  return (lighter + 0.05) / (darker + 0.05)
}

// One decimal, rounded down, so a failing color is never shown as reaching the minimum.
export function formatRatio(ratio: number): string {
  return (Math.floor(ratio * 10) / 10).toFixed(1)
}

export function toHsl(hex: string): [number, number, number] {
  const [r, g, b] = channels(hex)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const lightness = (max + min) / 2
  if (max === min) return [0, 0, lightness]
  const delta = max - min
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min)
  let hue: number
  if (max === r) hue = (g - b) / delta + (g < b ? 6 : 0)
  else if (max === g) hue = (b - r) / delta + 2
  else hue = (r - g) / delta + 4
  return [hue / 6, saturation, lightness]
}

export function fromHsl(hue: number, saturation: number, lightness: number): string {
  const channel = (p: number, q: number, t: number) => {
    const turn = t < 0 ? t + 1 : t > 1 ? t - 1 : t
    if (turn < 1 / 6) return p + (q - p) * 6 * turn
    if (turn < 1 / 2) return q
    if (turn < 2 / 3) return p + (q - p) * (2 / 3 - turn) * 6
    return p
  }
  let rgb: number[]
  if (saturation === 0) rgb = [lightness, lightness, lightness]
  else {
    const q =
      lightness < 0.5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation
    const p = 2 * lightness - q
    rgb = [channel(p, q, hue + 1 / 3), channel(p, q, hue), channel(p, q, hue - 1 / 3)]
  }
  return `#${rgb.map((value) => Math.round(value * 255).toString(16).padStart(2, '0')).join('')}`
}

// The shade of `hex` closest in lightness that reaches `minRatio` on `background`: same hue
// and saturation, lightness moved in 0.5-point steps, darker tried first at each distance.
// Null when `hex` already passes, or when no shade can.
export function suggestShade(hex: string, background: string, minRatio: number): string | null {
  if (contrastRatio(hex, background) >= minRatio) return null
  const [hue, saturation, lightness] = toHsl(hex)
  for (let step = 1; step * LIGHTNESS_STEP <= 1; step++) {
    const distance = step * LIGHTNESS_STEP
    for (const candidate of [lightness - distance, lightness + distance]) {
      if (candidate < 0 || candidate > 1) continue
      const shade = fromHsl(hue, saturation, candidate)
      if (contrastRatio(shade, background) >= minRatio) return shade
    }
  }
  return null
}

type ColorInputs = Record<ColorKey, string>

// The form's typed hex values as colors to save, or the boxes to flag. A box that doesn't
// hold a valid code must stop the save, rather than the picker's older value being sent.
export function readColorInputs(
  texts: ColorInputs,
): { colors: ColorInputs; errors: null } | { colors: null; errors: Partial<Record<ColorKey, string[]>> } {
  const primaryColor = normalizeHex(texts.primaryColor)
  const accentColor = normalizeHex(texts.accentColor)
  if (primaryColor && accentColor) return { colors: { primaryColor, accentColor }, errors: null }
  const errors: Partial<Record<ColorKey, string[]>> = {}
  if (!primaryColor) errors.primaryColor = [HEX_MESSAGE]
  if (!accentColor) errors.accentColor = [HEX_MESSAGE]
  return { colors: null, errors }
}
```

- [ ] **Step 4: Reuse the contrast math in `readableTextColor`**

In `src/features/branding/apply-branding.ts`, add `import { contrastRatio } from './color'` and replace the body of `readableTextColor` with:

```ts
export function readableTextColor(background: string): '#000000' | '#ffffff' {
  return contrastRatio(background, '#000000') > contrastRatio(background, '#ffffff')
    ? '#000000'
    : '#ffffff'
}
```

Keep its existing comment. A tie still gives white, as before.

- [ ] **Step 5: Run the tests to see them pass**

Run: `npm test -- src/features/branding`
Expected: PASS, including the unchanged `apply-branding.test.ts`.

If a round-trip case fails by one unit in a channel, keep the test and fix `fromHsl` or `toHsl`, and don't loosen the test. The algorithm above round-trips 8-bit colors exactly when it is implemented as written.

- [ ] **Step 6: Check and commit**

Run the gates: `npm run typecheck`, `npx biome check --line-ending=crlf .` and `npm test`.

```bash
git add src/features/branding/color.ts src/features/branding/color.test.ts src/features/branding/apply-branding.ts
git commit -m "feat: add hex parsing, contrast and shade suggestions for brand colors

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Hex boxes and the contrast warning in the form

**Files:**
- Modify: `src/features/branding/branding-form.tsx`

**Interfaces:**
- Consumes Task 1's `normalizeHex`, `contrastRatio`, `formatRatio`, `suggestShade`, `readColorInputs`, `PRIMARY_MIN_CONTRAST`, `HEX_MESSAGE` and `ColorKey`. Existing: `useUpdateBranding`, `generatePalette` (returns `BrandingInput`), and the `Button`, `Input` and `Label` UI components.
- Produces: the same `BrandingForm({ tenantId, current })` export. `admin.tsx` doesn't change.

This task has no component test, because relay-web has no setup for them. Its logic is covered by Task 1, and it is checked with typecheck, lint and the controller's manual run.

- [ ] **Step 1: Replace `branding-form.tsx`**

```tsx
import { Shuffle, TriangleAlert } from 'lucide-react'
import { type FormEvent, type ReactNode, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ApiError } from '@/lib/api'
import { type Branding, type BrandingInput, useUpdateBranding } from './api'
import {
  type ColorKey,
  contrastRatio,
  formatRatio,
  HEX_MESSAGE,
  normalizeHex,
  PRIMARY_MIN_CONTRAST,
  readColorInputs,
  suggestShade,
} from './color'
import { generatePalette } from './generate-palette'

type FieldErrors = Partial<Record<ColorKey, string[]>>

// The primary color is drawn as text and icons on this background.
const PAGE_BACKGROUND = '#ffffff'

// Superadmin only. Each save becomes a new branding version on the API.
export function BrandingForm({ tenantId, current }: { tenantId: string; current: Branding }) {
  const update = useUpdateBranding(tenantId)
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  // `texts` is what is typed in each hex box; `colors` is the last valid value of each, shown by
  // the pickers. Both start from the saved colors and follow them when they change from
  // outside the form, for example after a restore.
  const [texts, setTexts] = useState<BrandingInput>({
    primaryColor: current.primaryColor,
    accentColor: current.accentColor,
  })
  const [colors, setColors] = useState<BrandingInput>(texts)

  useEffect(() => {
    const saved = { primaryColor: current.primaryColor, accentColor: current.accentColor }
    setTexts(saved)
    setColors(saved)
  }, [current.primaryColor, current.accentColor])

  function clearError(key: ColorKey) {
    setFieldErrors(({ [key]: _, ...others }) => others)
  }

  // A picked color, a palette or a suggested shade: always valid, so both boxes and pickers.
  function setColor(key: ColorKey, value: string) {
    setTexts((previous) => ({ ...previous, [key]: value }))
    setColors((previous) => ({ ...previous, [key]: value }))
    clearError(key)
  }

  function onType(key: ColorKey, text: string) {
    setTexts((previous) => ({ ...previous, [key]: text }))
    const hex = normalizeHex(text)
    if (hex) setColors((previous) => ({ ...previous, [key]: hex }))
  }

  function onBlur(key: ColorKey) {
    const hex = normalizeHex(texts[key])
    if (!hex) {
      setFieldErrors((previous) => ({ ...previous, [key]: [HEX_MESSAGE] }))
      return
    }
    setTexts((previous) => ({ ...previous, [key]: hex }))
    clearError(key)
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const result = readColorInputs(texts)
    if (!result.colors) {
      setFieldErrors(result.errors)
      return
    }
    setFieldErrors({})
    setTexts(result.colors)
    setColors(result.colors)
    update.mutate(result.colors)
  }

  const typedPrimary = normalizeHex(texts.primaryColor)

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="flex flex-wrap gap-6">
        <ColorField
          id="primaryColor"
          label="Primary color"
          color={colors.primaryColor}
          text={texts.primaryColor}
          onPick={(value) => setColor('primaryColor', value)}
          onType={(text) => onType('primaryColor', text)}
          onBlur={() => onBlur('primaryColor')}
          errors={fieldErrors.primaryColor}
        >
          <ContrastWarning
            color={typedPrimary}
            onUse={(shade) => setColor('primaryColor', shade)}
          />
        </ColorField>
        <ColorField
          id="accentColor"
          label="Accent color"
          color={colors.accentColor}
          text={texts.accentColor}
          onPick={(value) => setColor('accentColor', value)}
          onType={(text) => onType('accentColor', text)}
          onBlur={() => onBlur('accentColor')}
          errors={fieldErrors.accentColor}
        />
      </div>
      {update.error && (
        <p className="text-sm text-destructive">
          {update.error instanceof ApiError ? update.error.message : 'Could not save. Try again.'}
        </p>
      )}
      {update.isSuccess && (
        <p className="text-sm text-muted-foreground">Saved. Open dashboards update right away.</p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            const palette = generatePalette()
            setColor('primaryColor', palette.primaryColor)
            setColor('accentColor', palette.accentColor)
          }}
        >
          <Shuffle />
          Generate palette
        </Button>
        <Button type="submit" disabled={update.isPending}>
          {update.isPending ? 'Saving…' : 'Save branding'}
        </Button>
      </div>
    </form>
  )
}

function ColorField(props: {
  id: ColorKey
  label: string
  color: string
  text: string
  onPick: (value: string) => void
  onType: (text: string) => void
  onBlur: () => void
  errors?: string[]
  children?: ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={props.id}>{props.label}</Label>
      <div className="flex items-center gap-2">
        <Input
          id={props.id}
          type="color"
          value={props.color}
          onChange={(event) => props.onPick(event.target.value)}
          className="h-10 w-20 p-1"
        />
        <Input
          aria-label={`${props.label} hex code`}
          value={props.text}
          onChange={(event) => props.onType(event.target.value)}
          onBlur={props.onBlur}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={!!props.errors}
          className="h-10 w-28 font-mono"
        />
      </div>
      {props.errors?.map((message) => (
        <p key={message} className="text-sm text-destructive">
          {message}
        </p>
      ))}
      {props.children}
    </div>
  )
}

// Always rendered, so screen readers announce the warning when it appears.
function ContrastWarning({
  color,
  onUse,
}: {
  color: string | null
  onUse: (shade: string) => void
}) {
  const ratio = color ? contrastRatio(color, PAGE_BACKGROUND) : null
  const failing = color !== null && ratio !== null && ratio < PRIMARY_MIN_CONTRAST
  const shade = failing ? suggestShade(color, PAGE_BACKGROUND, PRIMARY_MIN_CONTRAST) : null

  return (
    <div role="status" aria-live="polite">
      {failing && (
        <div className="flex max-w-sm flex-wrap items-center gap-2 text-sm text-amber-700">
          <TriangleAlert aria-hidden className="size-4 shrink-0" />
          <span>
            Hard to read as text on white ({formatRatio(ratio)}:1, needs {PRIMARY_MIN_CONTRAST}:1).
          </span>
          {shade && (
            <Button type="button" variant="outline" size="sm" onClick={() => onUse(shade)}>
              <span
                aria-hidden
                className="size-3 rounded-sm border"
                style={{ backgroundColor: shade }}
              />
              Use {shade}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
```

If TypeScript can't narrow `ratio` inside the JSX (it is typed `number | null`), compute `const ratio = color ? contrastRatio(color, PAGE_BACKGROUND) : 0` and use `failing = color !== null && ratio < PRIMARY_MIN_CONTRAST`. Make the smallest change that typechecks, and note it in the report.

- [ ] **Step 2: Check and commit**

Run the gates: `npm run typecheck`, then `npx biome check --line-ending=crlf .` (let Biome format your file), then `npm test`.

```bash
git add src/features/branding/branding-form.tsx
git commit -m "feat: add hex boxes and a contrast warning to the brand colors

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
