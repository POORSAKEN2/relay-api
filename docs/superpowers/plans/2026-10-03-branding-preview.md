# Branding Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Preview section under the brand color pickers shows the contractor's booking page and dashboard in the draft colors, and updates live before anything is saved.

**Architecture:**
- The theme uses Tailwind `@theme inline`, so color classes read the CSS variables directly. A preview frame that sets `--primary`, `--primary-foreground`, `--brand-accent` and `--brand-accent-foreground` inline recolors only what it contains.
- `brandingVars` produces those variables for both the live site (`applyBranding`) and the preview.
- The booking header and the sidebar header become shared components, `BookingHero` and `SidebarBrand`, and the sidebar link styling moves to `sidebar-links.ts`. The real pages and the preview both use them.
- This is web only, with no API change.

**Tech Stack:** relay-web: React 19, TypeScript, Tailwind v4, shadcn/ui (Base UI), react-router, lucide-react, vitest (node environment).

**Spec:** `relay-api/docs/superpowers/specs/2026-10-03-branding-preview-design.md`

## Global Constraints

- Repo: `D:\Sen\personal\HVAC\relay-web`, branch `feat/branding-preview`. The controller created it from `feat/branding-colors` at `52ca9e5`; never switch branches. Use the Bash tool with POSIX syntax (the machine is Windows).
- The untracked `src/features/auth/landing.test.ts` is the user's work in progress, and it already fails typecheck, lint and tests. Never edit, format, stage or delete it. Its failures don't count; any other failure does.
- Gates before each commit: `npm run typecheck`, `npx biome check --line-ending=crlf .` and `npm test`. Keep files CRLF with no BOM. Format only your own files: `npx biome check --line-ending=crlf --write <files>`.
- Commit messages end with exactly `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Use that line even if your own model name differs. Add files by path. Do not push.
- The refactor of `BookingShell` and `Sidebar` must not change how the real pages look or behave:
  - same classes and markup;
  - "Book a visit" while branding loads;
  - the exit button only when `onExit` is given;
  - both sidebar states, collapsed and expanded.
- Preview copy, copied exactly:
  - heading `Preview`
  - tabs `Booking page` and `Dashboard`
  - `aria-label` `Preview of <name>’s booking page` or `Preview of <name>’s dashboard` (with a curly apostrophe)
  - question `What do you need?`
  - choices `Repair`, `Maintenance` (selected) and `New system`
  - buttons `Continue` and `Book job`
  - page title `Dispatch`
- The preview uses the form's last *valid* colors (`colors`, not the typed `texts`). The name and logo come from the saved branding.
- The preview frame is `inert` and has `role="img"`.
- User-facing text uses curly apostrophes (’).

## Review Focus

1. **Nothing outside the preview frame changes color while editing.** The variables are set only on the frame, never on `<html>`. Checked by reading Task 3's code and by the manual run.
2. **The real booking page while branding is loading** still shows "Book a visit" with no logo, and shows the exit button only when `onExit` is given. Pinned by Task 2's code, which copies the markup verbatim.
3. **The collapsed staff sidebar** still shows the logo or initial in its 32px square, with the sr-only name. Pinned by Task 2.
4. **A half-typed hex code** (`#1d4`) doesn't blank or break the preview, because it receives `colors` and not `texts`. Pinned by Task 3's wiring.
5. **Keyboard users can't tab into the preview's fake buttons**, because of `inert`. Checked in the manual run.

---

### Task 1: `brandingVars`, shared by the live site and the preview

**Files:**
- Modify: `src/features/branding/apply-branding.ts`
- Modify: `src/features/branding/apply-branding.test.ts`

**Interfaces:**
- Produces:
  - `BrandingVars`, a record with the keys `'--primary' | '--primary-foreground' | '--brand-accent' | '--brand-accent-foreground'`
  - `brandingVars(colors: { primaryColor: string; accentColor: string }): BrandingVars`
- Unchanged: `applyBranding(colors)` and `readableTextColor(background)`.

- [ ] **Step 1: Write the failing test**

In `src/features/branding/apply-branding.test.ts`, change the import to `import { brandingVars, readableTextColor } from './apply-branding'` and append:

```ts
it('gives the brand colors and the text color readable on each', () => {
  expect(brandingVars({ primaryColor: '#1d4ed8', accentColor: '#facc15' })).toEqual({
    '--primary': '#1d4ed8',
    '--primary-foreground': '#ffffff',
    '--brand-accent': '#facc15',
    '--brand-accent-foreground': '#000000',
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm test -- src/features/branding/apply-branding.test.ts`
Expected: FAIL, because `brandingVars` is not exported.

- [ ] **Step 3: Implement**

In `src/features/branding/apply-branding.ts`, replace `applyBranding` with:

```ts
export type BrandingVars = Record<
  '--primary' | '--primary-foreground' | '--brand-accent' | '--brand-accent-foreground',
  string
>

// The CSS variables for a pair of brand colors. shadcn's own --accent is a neutral hover
// color, so the brand accent gets its own variable. Used on <html> for the live site and on
// the admin's preview frame.
export function brandingVars({ primaryColor, accentColor }: Colors): BrandingVars {
  return {
    '--primary': primaryColor,
    '--primary-foreground': readableTextColor(primaryColor),
    '--brand-accent': accentColor,
    '--brand-accent-foreground': readableTextColor(accentColor),
  }
}

// Sets the brand colors on <html>, so every component picks them up.
export function applyBranding(colors: Colors) {
  const style = document.documentElement.style
  for (const [name, value] of Object.entries(brandingVars(colors))) {
    style.setProperty(name, value)
  }
}
```

Keep `readableTextColor` and the `Colors` type as they are.

- [ ] **Step 4: Run the tests to see them pass**

Run: `npm test -- src/features/branding/apply-branding.test.ts`
Expected: PASS, both the new test and the existing `readableTextColor` cases.

- [ ] **Step 5: Check and commit**

Run the gates: `npm run typecheck`, `npx biome check --line-ending=crlf .` and `npm test`.

```bash
git add src/features/branding/apply-branding.ts src/features/branding/apply-branding.test.ts
git commit -m "feat: share the brand color variables between the site and a preview

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Shared booking header and sidebar pieces (no visible change)

**Files:**
- Create: `src/features/booking/booking-hero.tsx`
- Modify: `src/features/booking/booking-shell.tsx`
- Create: `src/components/sidebar-brand.tsx`
- Create: `src/components/sidebar-links.ts`
- Modify: `src/components/sidebar.tsx`

**Interfaces:**
- Produces:
  - `BookingHero({ name, logoUrl, onExit }: { name: string | null; logoUrl: string | null; onExit?: () => void })`
  - `SidebarBrand({ name, logoUrl, collapsed }: { name: string; logoUrl: string | null; collapsed?: boolean })`
  - `LINKS: { to: string; label: string; icon: LucideIcon }[]`
  - `navItemClass({ active, collapsed }: { active: boolean; collapsed?: boolean }): string`

This task has no new tests: the markup moves without changing, and relay-web has no component tests. It is checked with typecheck, lint, the existing suite and the controller's manual run.

- [ ] **Step 1: Create `BookingHero`**

Create `src/features/booking/booking-hero.tsx`. The markup below is the current `<header>` of `BookingShell`, unchanged, taking props instead of `useBranding()`:

```tsx
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'

// The booking page's brand-colored top: logo, heading and intro. `name` is null while the
// branding loads. `onExit` adds the close button. Shared with the admin's branding preview.
export function BookingHero({
  name,
  logoUrl,
  onExit,
}: {
  name: string | null
  logoUrl: string | null
  onExit?: () => void
}) {
  return (
    <header className="bg-primary px-4 pt-8 pb-20 text-primary-foreground sm:px-6 sm:pt-12 sm:pb-24">
      <div className="mx-auto max-w-2xl space-y-2">
        {logoUrl && (
          <img
            src={logoUrl}
            alt={name ?? ''}
            className="max-h-14 max-w-48 object-contain object-left"
          />
        )}
        <div className="flex items-start justify-between gap-4">
          <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            {name ? `Book with ${name}` : 'Book a visit'}
          </h1>
          {onExit && (
            <Button
              variant="ghost"
              aria-label="Exit booking"
              className="-mt-1 -mr-2 size-11 text-primary-foreground hover:bg-primary-foreground/10 hover:text-primary-foreground dark:hover:bg-primary-foreground/10"
              onClick={onExit}
            >
              <X className="size-6" />
            </Button>
          )}
        </div>
        <p className="text-sm text-primary-foreground/85 sm:text-base">
          A few quick questions and we’ll get someone out to you. It takes about two minutes.
        </p>
      </div>
    </header>
  )
}
```

- [ ] **Step 2: Use it in `BookingShell`**

In `src/features/booking/booking-shell.tsx`, replace the whole `<header>…</header>` element with:

```tsx
      <BookingHero
        name={branding?.name ?? null}
        logoUrl={branding?.logoUrl ?? null}
        onExit={onExit}
      />
```

Then update the imports:
- remove the `X` and `Button` imports, which are no longer used here;
- add `import { BookingHero } from './booking-hero'`.

Keep the outer `<div>`, the comment and `<main>` exactly as they are.

- [ ] **Step 3: Create the sidebar pieces**

Create `src/components/sidebar-links.ts`. Move `LINKS` here verbatim, along with its comment, from `sidebar.tsx`:

```ts
import { cn } from 'cn'
import {
  CalendarDays,
  ChartColumn,
  type LucideIcon,
  Settings,
  Users,
  Wrench,
} from 'lucide-react'

// Owner and office screens. More join as their modules arrive (customers, inbox, payments).
export const LINKS: { to: string; label: string; icon: LucideIcon }[] = [
  { to: '/dashboard', label: 'Dispatch', icon: CalendarDays },
  { to: '/technicians', label: 'Technicians', icon: Users },
  { to: '/services', label: 'Services', icon: Wrench },
  { to: '/analytics', label: 'Analytics', icon: ChartColumn },
  { to: '/settings', label: 'Booking settings', icon: Settings },
]

// How one sidebar link looks. Shared with the admin's branding preview.
export function navItemClass({ active, collapsed = false }: { active: boolean; collapsed?: boolean }) {
  return cn(
    'flex h-10 items-center gap-3 rounded-lg text-sm font-medium transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
    collapsed ? 'justify-center' : 'px-3',
    active
      ? 'bg-primary/10 text-primary'
      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
  )
}
```

Create `src/components/sidebar-brand.tsx`. The markup is the current brand-colored header `<div>` of `Sidebar`, unchanged:

```tsx
import { cn } from 'cn'

// The sidebar's brand-colored top: the contractor's logo, or its name. Collapsed, it shows the
// logo or the first letter in a small square. Shared with the admin's branding preview.
export function SidebarBrand({
  name,
  logoUrl,
  collapsed = false,
}: {
  name: string
  logoUrl: string | null
  collapsed?: boolean
}) {
  return (
    <div
      className={cn(
        'flex h-14 shrink-0 items-center bg-primary font-semibold text-primary-foreground',
        collapsed ? 'justify-center' : 'px-4',
      )}
    >
      {collapsed ? (
        <span
          title={name}
          className="flex size-8 items-center justify-center overflow-hidden rounded-md bg-white/15 text-sm"
        >
          {logoUrl ? (
            <img src={logoUrl} alt="" className="size-full object-contain" />
          ) : (
            <span aria-hidden>{name.charAt(0)}</span>
          )}
          <span className="sr-only">{name}</span>
        </span>
      ) : logoUrl ? (
        <img src={logoUrl} alt={name} className="max-h-8 max-w-full object-contain object-left" />
      ) : (
        <span className="truncate">{name}</span>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Use them in `Sidebar`**

In `src/components/sidebar.tsx`:
- Delete the `LINKS` constant and its comment. Add `import { LINKS, navItemClass } from './sidebar-links'` and `import { SidebarBrand } from './sidebar-brand'`. Remove the icon imports that only `LINKS` used (`CalendarDays`, `ChartColumn`, `Settings`, `Users` and `Wrench`). Keep `LogOut`, `LucideIcon`, `PanelLeftClose` and `PanelLeftOpen`.
- Replace the brand header `<div className={cn('flex h-14 …')}>…</div>` with `<SidebarBrand name={name} logoUrl={logoUrl} collapsed={collapsed} />`.
- Replace the `NavLink`'s `className={({ isActive }) => cn(…)}` with `className={({ isActive }) => navItemClass({ active: isActive, collapsed })}`.
- Keep everything else unchanged: `name`, `logoUrl`, the nav's `title` and `aria-label`, the user block and `SidebarButton`. Keep `cn` only if it is still used.

- [ ] **Step 5: Check and commit**

Run the gates: `npm run typecheck`, `npx biome check --line-ending=crlf .` and `npm test`.

Then check with a diff that the moved markup is identical: `git diff -- src/features/booking/booking-shell.tsx src/components/sidebar.tsx`. The removed lines must match the new files, apart from the prop names.

```bash
git add src/features/booking/booking-hero.tsx src/features/booking/booking-shell.tsx src/components/sidebar-brand.tsx src/components/sidebar-links.ts src/components/sidebar.tsx
git commit -m "refactor: share the booking header and sidebar header for the branding preview

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The Preview section

**Files:**
- Create: `src/features/branding/preview-samples.ts`
- Create: `src/features/branding/branding-preview.tsx`
- Modify: `src/features/branding/branding-form.tsx`

**Interfaces:**
- Consumes:
  - Task 1's `brandingVars`.
  - Task 2's `BookingHero`, `SidebarBrand`, `LINKS` and `navItemClass`.
  - Existing:
    - `BookingProgress({ current, onGoTo })`, where `current` is a `Step` and `'zip'` is step 2, "Area";
    - `Panel` and `ChoiceCard({ selected })` from `@/features/booking/booking-ui`;
    - `JobCard({ job, technicianName?, onOpen })` from `@/features/dispatch/job-card`;
    - the `BoardJob` type from `@/features/dispatch/api`;
    - `Button` from `@/components/ui/button`.
- Produces: `BrandingPreview({ colors, name, logoUrl }: { colors: { primaryColor: string; accentColor: string }; name: string; logoUrl: string | null })`.

This task has no component tests. It is checked with typecheck, lint and the controller's manual run.

- [ ] **Step 1: Sample content**

Create `src/features/branding/preview-samples.ts`:

```ts
import type { BoardJob } from '@/features/dispatch/api'

// Fixed content for the admin's branding preview. Typed with the real shapes, so a change to
// them breaks the build instead of the preview.

export const PREVIEW_SERVICES = ['Repair', 'Maintenance', 'New system'] as const
export const PREVIEW_SELECTED_SERVICE = 'Maintenance'

export const PREVIEW_JOBS: BoardJob[] = [
  {
    id: 'preview-1',
    status: 'booked',
    priority: false,
    source: 'web',
    technicianId: 'preview-technician',
    windowId: 'preview-window',
    windowLabel: '8–11 AM',
    customerName: 'Maria Lopez',
    city: 'Phoenix',
    serviceName: 'AC repair',
    problem: 'Blowing warm air',
  },
  {
    id: 'preview-2',
    status: 'booked',
    priority: true,
    source: 'ai',
    technicianId: null,
    windowId: null,
    windowLabel: 'Anytime',
    customerName: 'James Carter',
    city: 'Tempe',
    serviceName: 'No heat',
    problem: 'Furnace won’t start',
  },
]

export const PREVIEW_TECHNICIAN = 'Sam Patel'
```

If `BoardJob` has fields beyond the ones listed above, check `src/features/dispatch/api.ts` and add realistic values so it typechecks.

- [ ] **Step 2: The preview component**

Create `src/features/branding/branding-preview.tsx`:

```tsx
import { type CSSProperties, useState } from 'react'
import { SidebarBrand } from '@/components/sidebar-brand'
import { LINKS, navItemClass } from '@/components/sidebar-links'
import { Button } from '@/components/ui/button'
import { BookingHero } from '@/features/booking/booking-hero'
import { BookingProgress } from '@/features/booking/booking-progress'
import { ChoiceCard, Panel } from '@/features/booking/booking-ui'
import { JobCard } from '@/features/dispatch/job-card'
import { brandingVars } from './apply-branding'
import {
  PREVIEW_JOBS,
  PREVIEW_SELECTED_SERVICE,
  PREVIEW_SERVICES,
  PREVIEW_TECHNICIAN,
} from './preview-samples'

type Surface = 'booking' | 'dashboard'

const SURFACES: { id: Surface; label: string; described: string }[] = [
  { id: 'booking', label: 'Booking page', described: 'booking page' },
  { id: 'dashboard', label: 'Dashboard', described: 'dashboard' },
]

const noop = () => {}

// The contractor's booking page and dashboard in the colors being edited, before saving. The
// brand variables are set on the frame only, so nothing else on the admin page changes. The
// frame is inert: its buttons are pictures, not controls.
export function BrandingPreview({
  colors,
  name,
  logoUrl,
}: {
  colors: { primaryColor: string; accentColor: string }
  name: string
  logoUrl: string | null
}) {
  const [surface, setSurface] = useState<Surface>('booking')
  const described = SURFACES.find((option) => option.id === surface)?.described

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-sm font-medium">Preview</h3>
        <div className="flex gap-1">
          {SURFACES.map((option) => (
            <Button
              key={option.id}
              type="button"
              size="sm"
              variant={option.id === surface ? 'secondary' : 'ghost'}
              aria-pressed={option.id === surface}
              onClick={() => setSurface(option.id)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </div>
      <div
        role="img"
        aria-label={`Preview of ${name}’s ${described}`}
        inert
        className="max-h-88 max-w-2xl overflow-hidden rounded-lg border bg-muted/40"
        style={brandingVars(colors) as CSSProperties}
      >
        {surface === 'booking' ? (
          <BookingPreview name={name} logoUrl={logoUrl} />
        ) : (
          <DashboardPreview name={name} logoUrl={logoUrl} />
        )}
      </div>
    </section>
  )
}

function BookingPreview({ name, logoUrl }: { name: string; logoUrl: string | null }) {
  return (
    <div className="pb-6">
      <BookingHero name={name} logoUrl={logoUrl} />
      <div className="-mt-14 space-y-4 px-4 sm:px-6">
        <BookingProgress current="zip" onGoTo={noop} />
        <Panel className="space-y-4">
          <h2 className="text-lg font-semibold">What do you need?</h2>
          <div className="grid gap-3 sm:grid-cols-3">
            {PREVIEW_SERVICES.map((service) => (
              <ChoiceCard key={service} selected={service === PREVIEW_SELECTED_SERVICE}>
                <span className="font-medium">{service}</span>
              </ChoiceCard>
            ))}
          </div>
          <Button type="button" className="w-full">
            Continue
          </Button>
        </Panel>
      </div>
    </div>
  )
}

function DashboardPreview({ name, logoUrl }: { name: string; logoUrl: string | null }) {
  return (
    <div className="flex min-h-88 bg-background">
      <div className="w-56 shrink-0 border-r bg-card">
        <SidebarBrand name={name} logoUrl={logoUrl} />
        <div className="space-y-1 p-2">
          {LINKS.map(({ to, label, icon: Icon }) => (
            <div key={to} className={navItemClass({ active: to === '/dashboard' })}>
              <Icon className="size-5 shrink-0" aria-hidden />
              {label}
            </div>
          ))}
        </div>
      </div>
      <div className="min-w-0 flex-1 space-y-4 p-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-2xl font-semibold tracking-tight">Dispatch</h2>
          <Button type="button" size="sm">
            Book job
          </Button>
        </div>
        <div className="grid max-w-xs gap-2">
          {PREVIEW_JOBS.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              technicianName={job.technicianId ? PREVIEW_TECHNICIAN : undefined}
              onOpen={noop}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
```

If Biome's a11y rules object to `role="img"` on a `div`, keep the role and `aria-label`, and make the smallest change that satisfies the rule, such as an inline `biome-ignore` comment with the reason "a picture of a page, made inert". Note it in the report.

- [ ] **Step 3: Show it in the form**

In `src/features/branding/branding-form.tsx`:
- Add `import { BrandingPreview } from './branding-preview'`.
- Directly after the `<ContrastWarning … />` element, and before `{update.error && (`, add:

```tsx
      <BrandingPreview colors={colors} name={current.name} logoUrl={current.logoUrl} />
```

Pass `colors`, the last valid colors, and never `texts`.

- [ ] **Step 4: Check and commit**

Run the gates: `npm run typecheck`, `npx biome check --line-ending=crlf .` (let Biome format your files) and `npm test`.

```bash
git add src/features/branding/preview-samples.ts src/features/branding/branding-preview.tsx src/features/branding/branding-form.tsx
git commit -m "feat: preview the booking page and dashboard in the colors being edited

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
