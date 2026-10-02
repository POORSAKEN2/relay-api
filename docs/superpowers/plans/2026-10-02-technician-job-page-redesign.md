# Technician Job Page Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the technician's job page (`/jobs/:jobId`) after the designer's mockups and make the big bottom button always the technician's next step: On my way → I'm at the location → Review with homeowner → Job complete → Job done screen.

**Architecture:** Web only, in `relay-web/src/features/technician-jobs`. One pure function, `nextStep()`, decides the bottom button. `JobDetails` lays out the page (brand band, hero card, body card) or the full-screen on-the-way view while en route; `JobActions` owns the fixed bottom bar, every sheet that moves the job (including the homeowner's review, moved from `JobCharges`) and the done screen. No API change.

**Tech Stack:** React 19, React Router 8, TanStack Query 5, Base UI dialogs (shadcn), Tailwind 4, lucide-react, sonner, Vitest.

**Spec:** `relay-api/docs/superpowers/specs/2026-10-02-technician-job-page-redesign-design.md`

## Global Constraints

- Work in `relay-web` on the current branch (`feat/job-repairs`). **Do not commit**; leave changes in the working tree. The user commits.
- Run commands from `relay-web/`. Biome only on touched files: `npx biome check --write <paths>` (never on all of `src`).
- Lean code a junior developer can read top to bottom: no new dependencies, no generic helpers, no config options.
- Brand colors only: `bg-primary`, `text-primary`, `text-primary-foreground`, `ring-primary`. No fixed blues or navies. Status chips keep `STATUS[...].chip`. Font stays Geist.
- `ChargeLines` (`src/features/charges/charge-lines.tsx`) is shared with the office drawer: do not change it.
- Exact copy (curly apostrophes `’`):
  - Bottom button: `On my way`, `I’m at the location`, `Review with homeowner · <money>`, `Job complete`.
  - Small links: `I’m already here`, `Running late`, `Can’t get in`.
  - Messages: `The office will reschedule this visit.`, `Done at <completedLabel>.`
  - Review sheet: `Your repair estimate`, `Please check the repairs below. Your technician starts once you approve.`, `Total if approved`, `Approve <money>`, `Decline repairs`, `Back`.
  - Complete dialog: `Mark this visit done?`, `Approved total <money>. This can’t be undone.`, `Cancel`, `Job complete`.
  - Add repair: `Add repair`, `The homeowner approves the price before you start.`, `Quantity`, `Add repair · <money>`, `Pick a repair`.
  - On the way: `On the way to`, `Open in Maps`, `Job details`; job page while en route: `Back to directions`.
  - Done screen: `Job done!`, `Approved total`, `Back to your jobs · <n>s`.
  - Back link: `Your jobs`. Network failure: `Couldn’t update the job. Check your connection and try again.`
- `<money>` is always `formatMoney(cents)` from `@/lib/format`.

## Files

- Create `src/features/technician-jobs/next-step.ts`, `next-step.test.ts`.
- Modify `src/features/technician-jobs/maps.ts`, `maps.test.ts` (`addressLine`).
- Create `src/features/technician-jobs/job-done.tsx`.
- Rewrite `src/features/technician-jobs/job-actions.tsx`, `job-charges.tsx`, `job-details.tsx`.
- Create `src/features/technician-jobs/job-header.tsx`, `on-the-way.tsx`.
- Modify `src/routes/job.tsx`.

---

### Task 1: Pure helpers — `nextStep()` and `addressLine()`

**Files:**
- Create: `relay-web/src/features/technician-jobs/next-step.ts`
- Create: `relay-web/src/features/technician-jobs/next-step.test.ts`
- Modify: `relay-web/src/features/technician-jobs/maps.ts`
- Modify: `relay-web/src/features/technician-jobs/maps.test.ts`

**Interfaces:**
- Produces: `type NextStep = 'on-my-way' | 'start' | 'review' | 'complete'`;
  `nextStep(status: JobStatus, repairsWaiting: boolean): NextStep | null`;
  `addressLine(address: { street: string; unit: string | null; city: string; state: string; zip: string }): string`;
  `mapsUrl(address)` unchanged in signature and output.

- [ ] **Step 1: Write the failing tests**

Create `relay-web/src/features/technician-jobs/next-step.test.ts`:

```ts
import { expect, it } from 'vitest'
import { nextStep } from './next-step'

it('heads out from a booked job', () => {
  expect(nextStep('booked', false)).toBe('on-my-way')
})

it('starts the job once en route', () => {
  expect(nextStep('en_route', false)).toBe('start')
})

it('asks the homeowner before finishing while repairs wait', () => {
  expect(nextStep('in_progress', true)).toBe('review')
  expect(nextStep('in_progress', false)).toBe('complete')
})

it('has no next step for a job that is over or not the technician’s to move', () => {
  for (const status of ['held', 'expired', 'no_access', 'done', 'cancelled'] as const) {
    expect(nextStep(status, false)).toBeNull()
  }
})
```

Replace `relay-web/src/features/technician-jobs/maps.test.ts` with:

```ts
import { expect, it } from 'vitest'
import { addressLine, mapsUrl } from './maps'

const palmSt = { street: '12 Palm St', unit: null, city: 'Phoenix', state: 'AZ', zip: '85004' }

it('writes the address on one line', () => {
  expect(addressLine(palmSt)).toBe('12 Palm St, Phoenix, AZ 85004')
  expect(addressLine({ ...palmSt, unit: 'Apt 2' })).toBe('12 Palm St, Apt 2, Phoenix, AZ 85004')
})

it('searches Google Maps for the address', () => {
  expect(mapsUrl(palmSt)).toBe(
    'https://www.google.com/maps/search/?api=1&query=12%20Palm%20St%2C%20Phoenix%2C%20AZ%2085004',
  )
})

it('includes the unit when there is one', () => {
  expect(mapsUrl({ ...palmSt, unit: 'Apt 2' })).toBe(
    'https://www.google.com/maps/search/?api=1&query=12%20Palm%20St%2C%20Apt%202%2C%20Phoenix%2C%20AZ%2085004',
  )
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run src/features/technician-jobs`
Expected: FAIL — `next-step` cannot be resolved; `addressLine` is not a function.

- [ ] **Step 3: Write the code**

Create `relay-web/src/features/technician-jobs/next-step.ts`:

```ts
import type { JobStatus } from '@/features/dispatch/api'

export type NextStep = 'on-my-way' | 'start' | 'review' | 'complete'

// The big button on a technician's job: always their next step. Repairs waiting for the
// homeowner come before Job complete, so no job finishes with an unanswered estimate.
export function nextStep(status: JobStatus, repairsWaiting: boolean): NextStep | null {
  if (status === 'booked') return 'on-my-way'
  if (status === 'en_route') return 'start'
  if (status === 'in_progress') return repairsWaiting ? 'review' : 'complete'
  return null
}
```

Replace `relay-web/src/features/technician-jobs/maps.ts` with:

```ts
type Address = { street: string; unit: string | null; city: string; state: string; zip: string }

// '12 Palm St, Apt 2, Phoenix, AZ 85004'
export function addressLine(address: Address): string {
  return [address.street, address.unit, address.city, `${address.state} ${address.zip}`]
    .filter(Boolean)
    .join(', ')
}

// A Google Maps search for an address. Phones open it in their Maps app.
export function mapsUrl(address: Address): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addressLine(address))}`
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run src/features/technician-jobs`
Expected: PASS (next-step, maps, arrival).

- [ ] **Step 5: Format and type-check**

Run: `npx biome check --write src/features/technician-jobs/next-step.ts src/features/technician-jobs/next-step.test.ts src/features/technician-jobs/maps.ts src/features/technician-jobs/maps.test.ts`
Run: `npm run typecheck`
Expected: no errors.

---

### Task 2: Bottom bar, review sheet, done screen, Add repair restyle

**Files:**
- Create: `relay-web/src/features/technician-jobs/job-done.tsx`
- Rewrite: `relay-web/src/features/technician-jobs/job-actions.tsx`
- Rewrite: `relay-web/src/features/technician-jobs/job-charges.tsx`
- Modify: `relay-web/src/features/technician-jobs/job-details.tsx` (one line: pass `charges` to `JobActions`)

**Interfaces:**
- Consumes: `nextStep`, `NextStep` from `./next-step` (Task 1); `useJobAction`, `useRepairAction`, `JobAction`, `MyJob` from `./api`; `arrivalPreview` from `./arrival`.
- Produces: `JobActions({ job, charges }: { job: MyJob['job']; charges: Charges })` — renders a `fixed` bottom bar (callers add `pb-40` to the page), the inline "Done at" / "reschedule" message, or the done screen; `JobCharges({ job, charges })` — lines plus Add repair, no review button; `JobDone({ totalCents }: { totalCents: number })`.

- [ ] **Step 1: Create the done screen**

Create `relay-web/src/features/technician-jobs/job-done.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { Button } from '@/components/ui/button'
import { formatMoney } from '@/lib/format'

const SECONDS = 4

// Shown right after the technician finishes a job, then back to their list. Tapping the
// button goes back now.
export function JobDone({ totalCents }: { totalCents: number }) {
  const navigate = useNavigate()
  const [left, setLeft] = useState(SECONDS)

  useEffect(() => {
    if (left === 0) {
      navigate('/jobs')
      return
    }
    const timer = setTimeout(() => setLeft(left - 1), 1000)
    return () => clearTimeout(timer)
  }, [left, navigate])

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center bg-background px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      <div className="flex flex-1 flex-col items-center justify-center gap-6 text-center">
        <h1 className="text-4xl font-semibold tracking-tight">Job done!</h1>
        <span
          aria-hidden
          className="text-8xl animate-in fade-in zoom-in-50 duration-500 motion-reduce:animate-none"
        >
          👏
        </span>
        <p className="text-base text-muted-foreground">
          Approved total{' '}
          <span className="font-semibold text-foreground tabular-nums">
            {formatMoney(totalCents)}
          </span>
        </p>
      </div>
      <Button className="h-14 w-full max-w-xl rounded-xl text-base" onClick={() => navigate('/jobs')}>
        Back to your jobs · {left}s
      </Button>
    </div>
  )
}
```

- [ ] **Step 2: Rewrite `job-actions.tsx`**

Replace `relay-web/src/features/technician-jobs/job-actions.tsx` with:

```tsx
import { ArrowLeft, Loader2 } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'
import type { Charges } from '@/features/charges/api'
import { ChargeLines } from '@/features/charges/charge-lines'
import type { JobStatus } from '@/features/dispatch/api'
import { NetworkError } from '@/lib/api'
import { errorMessage } from '@/lib/errors'
import { formatMoney } from '@/lib/format'
import { type JobAction, type MyJob, useJobAction, useRepairAction } from './api'
import { arrivalPreview } from './arrival'
import { JobDone } from './job-done'
import { type NextStep, nextStep } from './next-step'

type SheetName = 'on-my-way' | 'running-late' | 'no-access' | 'review' | 'complete'
type LinkName = 'start' | 'running-late' | 'no-access'

const STEP_LABELS: Record<NextStep, string> = {
  'on-my-way': 'On my way',
  start: 'I’m at the location',
  review: 'Review with homeowner',
  complete: 'Job complete',
}

// Quieter moves above the big button. The API applies the same status rules as the office's
// drawer; this only hides moves it would refuse.
const LINKS: Partial<Record<JobStatus, LinkName[]>> = {
  booked: ['start', 'running-late', 'no-access'],
  en_route: ['running-late', 'no-access'],
}

const LINK_LABELS: Record<LinkName, string> = {
  start: 'I’m already here',
  'running-late': 'Running late',
  'no-access': 'Can’t get in',
}

const ARRIVAL_MINUTES = [15, 30, 45, 60]
const LATE_MINUTES = [...ARRIVAL_MINUTES, 90]

// The technician's next step as one big button fixed to the bottom of the screen, quieter
// moves above it, and the sheets they open. After Job complete it shows the done screen.
export function JobActions({ job, charges }: { job: MyJob['job']; charges: Charges }) {
  const [sheet, setSheet] = useState<SheetName | null>(null)
  const [note, setNote] = useState('')
  const [finished, setFinished] = useState(false)
  const action = useJobAction(job.id)
  const repairs = useRepairAction(job.id)
  const busy = action.isPending || repairs.isPending
  const waiting = charges.lines.some((line) => line.status === 'proposed')
  const step = nextStep(job.status, waiting)
  const estimate = formatMoney(charges.approvedTotalCents + charges.proposedTotalCents)

  function showError(error: Error) {
    setSheet(null)
    toast.error(
      error instanceof NetworkError
        ? 'Couldn’t update the job. Check your connection and try again.'
        : errorMessage(error),
    )
  }

  function run(change: JobAction, onDone?: () => void) {
    action.mutate(change, {
      onSuccess: () => {
        setSheet(null)
        setNote('')
        onDone?.()
      },
      onError: showError,
    })
  }

  function decide(decision: 'approved' | 'declined') {
    repairs.mutate({ action: 'decide', decision }, { onSuccess: () => setSheet(null), onError: showError })
  }

  function press(name: NextStep | LinkName) {
    if (name === 'start') run({ action: 'start' })
    else setSheet(name)
  }

  // A spinner on the button whose move is saving.
  const pending = (name: string) => action.isPending && action.variables?.action === name

  if (finished) return <JobDone totalCents={charges.approvedTotalCents} />
  if (job.status === 'no_access') {
    return <Message>The office will reschedule this visit.</Message>
  }
  if (job.status === 'done') return <Message>Done at {job.completedLabel}.</Message>
  if (!step) return null
  const links = LINKS[job.status] ?? []

  return (
    <>
      <div className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 px-4 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))] backdrop-blur">
        <div className="mx-auto max-w-xl space-y-1">
          {links.length > 0 && (
            <div className="flex flex-wrap justify-center">
              {links.map((name) => (
                <Button
                  key={name}
                  variant="ghost"
                  className="h-10 px-3 text-muted-foreground"
                  disabled={busy}
                  onClick={() => press(name)}
                >
                  {pending(name) && <Loader2 className="animate-spin" />}
                  {LINK_LABELS[name]}
                </Button>
              ))}
            </div>
          )}
          <Button
            className="h-14 w-full rounded-xl text-base"
            disabled={busy}
            onClick={() => press(step)}
          >
            {pending(step) && <Loader2 className="animate-spin" />}
            {step === 'review' ? `${STEP_LABELS.review} · ${estimate}` : STEP_LABELS[step]}
          </Button>
        </div>
      </div>

      <MinutesSheet
        open={sheet === 'on-my-way'}
        title="How far away are you?"
        description="We’ll text the homeowner your arrival time."
        minutes={ARRIVAL_MINUTES}
        timeZone={job.timezone}
        busy={busy}
        onPick={(minutes) => run({ action: 'on-my-way', minutes })}
        onClose={() => setSheet(null)}
      />
      <MinutesSheet
        open={sheet === 'running-late'}
        title="How far away are you now?"
        description="We’ll text the homeowner the new time."
        minutes={LATE_MINUTES}
        timeZone={job.timezone}
        busy={busy}
        onPick={(minutes) => run({ action: 'running-late', minutes })}
        onClose={() => setSheet(null)}
      />

      <Dialog open={sheet === 'no-access'} onOpenChange={(open) => !open && setSheet(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Couldn’t get in?</DialogTitle>
            <DialogDescription>
              We’ll text the homeowner and the office will reschedule.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="no-access-note">Note (optional)</Label>
            <Textarea
              id="no-access-note"
              rows={3}
              maxLength={1000}
              placeholder="Gate locked, knocked and called at 1:30"
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setSheet(null)}>
              Cancel
            </Button>
            <Button disabled={busy} onClick={() => run({ action: 'no-access', note })}>
              {busy && <Loader2 className="animate-spin" />}
              Mark no access
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={sheet === 'complete'} onOpenChange={(open) => !open && setSheet(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mark this visit done?</DialogTitle>
            <DialogDescription>
              Approved total {formatMoney(charges.approvedTotalCents)}. This can’t be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setSheet(null)}>
              Cancel
            </Button>
            <Button
              disabled={busy}
              onClick={() => run({ action: 'complete' }, () => setFinished(true))}
            >
              {busy && <Loader2 className="animate-spin" />}
              Job complete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ReviewSheet
        open={sheet === 'review'}
        charges={charges}
        total={estimate}
        busy={busy}
        onDecide={decide}
        onClose={() => setSheet(null)}
      />
    </>
  )
}

function Message({ children }: { children: ReactNode }) {
  return <p className="mx-auto max-w-xl px-4 pt-6 text-center text-muted-foreground">{children}</p>
}

// Picks how far away the technician is; each choice shows the clock time it means.
function MinutesSheet(props: {
  open: boolean
  title: string
  description: string
  minutes: number[]
  timeZone: string
  busy: boolean
  onPick: (minutes: number) => void
  onClose: () => void
}) {
  const now = new Date()
  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          <DialogDescription>{props.description}</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-2">
          {props.minutes.map((minutes) => (
            <Button
              key={minutes}
              variant="outline"
              className="h-12"
              disabled={props.busy}
              onClick={() => props.onPick(minutes)}
            >
              {arrivalPreview(now, minutes, props.timeZone)}
            </Button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}

// Handed to the homeowner, full screen: every line, the total if they approve, and their
// answer. Back closes it and records nothing.
function ReviewSheet(props: {
  open: boolean
  charges: Charges
  total: string
  busy: boolean
  onDecide: (decision: 'approved' | 'declined') => void
  onClose: () => void
}) {
  return (
    <Sheet open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <SheetContent side="bottom" showCloseButton={false} className="data-[side=bottom]:h-dvh">
        <SheetHeader className="pt-8">
          <SheetTitle className="text-3xl font-semibold tracking-tight">
            Your repair estimate
          </SheetTitle>
          <SheetDescription className="text-base">
            Please check the repairs below. Your technician starts once you approve.
          </SheetDescription>
        </SheetHeader>
        <div className="flex-1 space-y-4 overflow-y-auto px-4 text-base">
          <ChargeLines charges={props.charges} />
          <p className="flex justify-between text-lg font-semibold">
            <span>Total if approved</span>
            <span className="tabular-nums">{props.total}</span>
          </p>
        </div>
        <SheetFooter className="pb-[max(1rem,env(safe-area-inset-bottom))]">
          <Button
            className="h-14 rounded-xl text-base"
            disabled={props.busy}
            onClick={() => props.onDecide('approved')}
          >
            {props.busy && <Loader2 className="animate-spin" />}
            Approve {props.total}
          </Button>
          <Button
            variant="outline"
            className="h-12 rounded-xl text-base"
            disabled={props.busy}
            onClick={() => props.onDecide('declined')}
          >
            Decline repairs
          </Button>
          <Button variant="ghost" className="h-11" disabled={props.busy} onClick={props.onClose}>
            <ArrowLeft />
            Back
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
```

- [ ] **Step 3: Rewrite `job-charges.tsx`**

Replace `relay-web/src/features/technician-jobs/job-charges.tsx` with:

```tsx
import { cn } from 'cn'
import { Loader2, Minus, Plus } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { Charges } from '@/features/charges/api'
import { ChargeLines } from '@/features/charges/charge-lines'
import { NetworkError } from '@/lib/api'
import { errorMessage } from '@/lib/errors'
import { formatMoney } from '@/lib/format'
import { type MyJob, type RepairAction, usePriceList, useRepairAction } from './api'

// The job's charges on the technician's page. While the visit is in progress the technician
// adds repairs from the price list; the bottom button then hands the phone to the homeowner.
export function JobCharges({ job, charges }: { job: MyJob['job']; charges: Charges }) {
  const [adding, setAdding] = useState(false)
  const action = useRepairAction(job.id)
  const inProgress = job.status === 'in_progress'

  function run(change: RepairAction, onDone?: () => void) {
    action.mutate(change, {
      onSuccess: () => onDone?.(),
      onError: (error) => {
        setAdding(false)
        toast.error(
          error instanceof NetworkError
            ? 'Couldn’t update the job. Check your connection and try again.'
            : errorMessage(error),
        )
      },
    })
  }

  return (
    <div className="space-y-3">
      <ChargeLines
        charges={charges}
        busy={action.isPending}
        onRemove={inProgress ? (itemId) => run({ action: 'remove', itemId }) : undefined}
      />
      {inProgress && (
        <Button
          variant="outline"
          className="h-12 w-full rounded-xl text-base"
          disabled={action.isPending}
          onClick={() => setAdding(true)}
        >
          <Plus /> Add repair
        </Button>
      )}

      <AddRepairSheet
        open={adding}
        busy={action.isPending}
        onAdd={(priceItemId, quantity) =>
          run({ action: 'add', priceItemId, quantity }, () => setAdding(false))
        }
        onClose={() => setAdding(false)}
      />
    </div>
  )
}

// Pick a repair from the price list and how many. Closes with its X or a tap outside.
function AddRepairSheet(props: {
  open: boolean
  busy: boolean
  onAdd: (priceItemId: string, quantity: number) => void
  onClose: () => void
}) {
  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent className="max-h-[90dvh] gap-5 overflow-y-auto rounded-2xl p-5">
        <DialogHeader>
          <DialogTitle className="text-lg">Add repair</DialogTitle>
          <DialogDescription>The homeowner approves the price before you start.</DialogDescription>
        </DialogHeader>
        {/* Mounted only while open, so each opening starts fresh. */}
        {props.open && <AddRepairForm busy={props.busy} onAdd={props.onAdd} />}
      </DialogContent>
    </Dialog>
  )
}

function AddRepairForm(props: {
  busy: boolean
  onAdd: (priceItemId: string, quantity: number) => void
}) {
  const prices = usePriceList()
  const [picked, setPicked] = useState<string | null>(null)
  const [quantity, setQuantity] = useState(1)
  const price = prices.data?.find((item) => item.id === picked)

  return (
    <>
      {prices.isPending && <p className="text-muted-foreground">Loading prices…</p>}
      {prices.isError && <p className="text-sm text-destructive">{errorMessage(prices.error)}</p>}
      {prices.data?.length === 0 && (
        <p className="text-sm text-muted-foreground">
          The office hasn’t added any repair prices yet.
        </p>
      )}
      <ul className="space-y-2">
        {prices.data?.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              aria-pressed={picked === item.id}
              className={cn(
                'flex w-full items-center justify-between gap-3 rounded-xl bg-card p-4 text-left shadow-sm ring-1 ring-foreground/10 outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
                picked === item.id && 'bg-primary/5 ring-2 ring-primary',
              )}
              onClick={() => setPicked(item.id)}
            >
              <span>{item.name}</span>
              <span className="tabular-nums">{formatMoney(item.priceCents)}</span>
            </button>
          </li>
        ))}
      </ul>
      {price && (
        <div className="flex items-center justify-between gap-3">
          <span className="text-base font-medium">Quantity</span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon-lg"
              aria-label="One fewer"
              disabled={quantity <= 1}
              onClick={() => setQuantity(quantity - 1)}
            >
              <Minus />
            </Button>
            <span className="w-8 text-center text-base tabular-nums">{quantity}</span>
            <Button
              variant="outline"
              size="icon-lg"
              aria-label="One more"
              disabled={quantity >= 20}
              onClick={() => setQuantity(quantity + 1)}
            >
              <Plus />
            </Button>
          </div>
        </div>
      )}
      <Button
        className="h-12 w-full rounded-xl text-base"
        disabled={!price || props.busy}
        onClick={() => price && props.onAdd(price.id, quantity)}
      >
        {props.busy && <Loader2 className="animate-spin" />}
        {price ? `Add repair · ${formatMoney(price.priceCents * quantity)}` : 'Pick a repair'}
      </Button>
    </>
  )
}
```

- [ ] **Step 4: Pass `charges` to `JobActions` in `job-details.tsx`**

In `relay-web/src/features/technician-jobs/job-details.tsx`, change:

```tsx
        <JobActions job={job} />
```

to:

```tsx
        <JobActions job={job} charges={charges} />
```

(Task 3 rewrites this file; this keeps it compiling until then.)

- [ ] **Step 5: Format, type-check, test**

Run: `npx biome check --write src/features/technician-jobs/job-done.tsx src/features/technician-jobs/job-actions.tsx src/features/technician-jobs/job-charges.tsx src/features/technician-jobs/job-details.tsx`
Run: `npm run typecheck`
Run: `npx vitest run src/features/technician-jobs`
Expected: no errors; tests pass.

---

### Task 3: Job page layout and on-the-way screen

**Files:**
- Create: `relay-web/src/features/technician-jobs/job-header.tsx`
- Create: `relay-web/src/features/technician-jobs/on-the-way.tsx`
- Rewrite: `relay-web/src/features/technician-jobs/job-details.tsx`
- Modify: `relay-web/src/routes/job.tsx`

**Interfaces:**
- Consumes: `addressLine`, `mapsUrl` from `./maps` (Task 1); `JobActions({ job, charges })`, `JobCharges({ job, charges })` (Task 2); `useMyJob`, `MyJob` from `./api`; `STATUS`, `SYSTEM_TYPE_LABELS` from `@/features/dispatch/labels`; `SignOutButton` from `@/features/auth/sign-out-button`.
- Produces: `JobHeader({ job }: { job: MyJob['job'] })`, `BackLink({ className }: { className?: string })`, `OnTheWay({ job, onShowDetails }: { job: MyJob['job']; onShowDetails: () => void })`, `JobDetails({ jobId }: { jobId: string })` (same signature as today).

- [ ] **Step 1: Create `job-header.tsx`**

Create `relay-web/src/features/technician-jobs/job-header.tsx`:

```tsx
import { cn } from 'cn'
import { ArrowLeft, Calendar, Clock, MessageSquare, Phone } from 'lucide-react'
import { Link } from 'react-router'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { STATUS } from '@/features/dispatch/labels'
import type { MyJob } from './api'

// Who and when, with Call and Text: the top of the job page and the bottom of the on-the-way
// screen.
export function JobHeader({ job }: { job: MyJob['job'] }) {
  const status = STATUS[job.status]
  const phone = job.customer.phone

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {job.priority && <Badge className="bg-red-600 text-white">PRIORITY</Badge>}
        <Badge className={status.chip}>{status.label}</Badge>
      </div>
      <h2 className="text-3xl font-semibold tracking-tight">{job.customer.name}</h2>
      <p className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="inline-flex items-center gap-1.5">
          <Clock className="size-4" />
          {job.windowLabel}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Calendar className="size-4" />
          {job.dateLabel}
        </span>
      </p>
      {job.etaLabel && <p className="font-medium text-sky-800">Arriving about {job.etaLabel}</p>}
      {phone && (
        <div className="grid grid-cols-2 gap-2">
          <a href={`tel:${phone}`} className={cn(buttonVariants(), 'h-12 rounded-xl text-base')}>
            <Phone />
            Call
          </a>
          <a
            href={`sms:${phone}`}
            className={cn(buttonVariants({ variant: 'outline' }), 'h-12 rounded-xl text-base')}
          >
            <MessageSquare />
            Text
          </a>
        </div>
      )}
    </div>
  )
}

// Back to the technician's list. The caller picks the color for its background.
export function BackLink({ className }: { className?: string }) {
  return (
    <Link
      to="/jobs"
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md text-sm font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50',
        className,
      )}
    >
      <ArrowLeft className="size-4" />
      Your jobs
    </Link>
  )
}
```

- [ ] **Step 2: Create `on-the-way.tsx`**

Create `relay-web/src/features/technician-jobs/on-the-way.tsx`:

```tsx
import { cn } from 'cn'
import { MapPin, Navigation } from 'lucide-react'
import { Button, buttonVariants } from '@/components/ui/button'
import type { MyJob } from './api'
import { BackLink, JobHeader } from './job-header'
import { addressLine, mapsUrl } from './maps'

// While the technician drives: where to in big type, the access notes, and a way into Maps.
// The page's bottom bar sits under it (I'm at the location).
export function OnTheWay({ job, onShowDetails }: { job: MyJob['job']; onShowDetails: () => void }) {
  const { property } = job
  const maps = mapsUrl(property)

  return (
    <div className="mx-auto flex min-h-[calc(100svh-10rem)] max-w-xl flex-col px-4 pt-3">
      <BackLink className="self-start text-primary" />
      <div className="flex flex-1 flex-col items-center justify-center gap-6 py-8 text-center">
        <div className="space-y-1">
          <h1 className="text-3xl font-semibold tracking-tight">On the way to</h1>
          <p className="text-lg text-muted-foreground">{job.customer.name}</p>
        </div>
        <a
          href={maps}
          target="_blank"
          rel="noreferrer"
          aria-label="Open in Maps"
          className="rounded-full p-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <Navigation className="size-28 fill-foreground" />
        </a>
        <div className="space-y-1">
          <p className="text-base font-medium">{addressLine(property)}</p>
          {property.notes && <p className="text-muted-foreground">Access: {property.notes}</p>}
        </div>
        <a
          href={maps}
          target="_blank"
          rel="noreferrer"
          className={cn(buttonVariants({ variant: 'outline' }), 'h-11 rounded-xl px-4')}
        >
          <MapPin />
          Open in Maps
        </a>
      </div>
      <div className="space-y-2">
        <JobHeader job={job} />
        <Button variant="link" className="h-auto w-full p-1" onClick={onShowDetails}>
          Job details
        </Button>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Rewrite `job-details.tsx`**

Replace `relay-web/src/features/technician-jobs/job-details.tsx` with:

```tsx
import { cn } from 'cn'
import { Loader2, Navigation, StickyNote } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { SignOutButton } from '@/features/auth/sign-out-button'
import { SYSTEM_TYPE_LABELS } from '@/features/dispatch/labels'
import { errorMessage } from '@/lib/errors'
import { type MyJob, useMyJob } from './api'
import { JobActions } from './job-actions'
import { JobCharges } from './job-charges'
import { BackLink, JobHeader } from './job-header'
import { addressLine, mapsUrl } from './maps'
import { OnTheWay } from './on-the-way'

const noteTime = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})

const ROW = 'flex items-start gap-3 rounded-2xl bg-card p-4 shadow-sm ring-1 ring-foreground/5'

// Everything a technician needs for one visit, with the next step fixed to the bottom. While
// en route it shows the on-the-way screen instead, until they open the job details. A job that
// stops being theirs (reassigned, cancelled) answers 404, which shows the API's message and a
// way back.
export function JobDetails({ jobId }: { jobId: string }) {
  const detail = useMyJob(jobId)
  const [showDetails, setShowDetails] = useState(false)

  if (detail.isPending) {
    return (
      <p className="flex items-center gap-2 p-4 text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Loading the job…
      </p>
    )
  }
  if (detail.isError) {
    return (
      <div className="space-y-3 p-4">
        <p>{errorMessage(detail.error)}</p>
        <BackLink className="text-primary" />
      </div>
    )
  }

  const { job, charges } = detail.data
  const enRoute = job.status === 'en_route'
  const directions = enRoute && !showDetails

  return (
    <div className={cn('min-h-svh pb-40 text-sm', directions ? 'bg-background' : 'bg-muted/40')}>
      {directions ? (
        <OnTheWay job={job} onShowDetails={() => setShowDetails(true)} />
      ) : (
        <>
          <div className="h-56 bg-primary">
            <div className="mx-auto flex max-w-xl items-center justify-between px-4 py-3">
              <BackLink className="text-primary-foreground" />
              <SignOutButton to="/sign-in/phone" />
            </div>
          </div>
          <div className="relative mx-auto -mt-40 max-w-xl space-y-3 px-4">
            <section className="space-y-3 rounded-3xl bg-card p-5 shadow-sm">
              <JobHeader job={job} />
              {enRoute && (
                <Button variant="link" className="h-auto p-0" onClick={() => setShowDetails(false)}>
                  Back to directions
                </Button>
              )}
            </section>
            <JobInfo detail={detail.data} />
          </div>
        </>
      )}
      <JobActions job={job} charges={charges} />
    </div>
  )
}

// The problem, the address, the office's notes and the charges, in one card.
function JobInfo({ detail }: { detail: MyJob }) {
  const { job, notes, photos, charges } = detail
  const { property } = job

  return (
    <section className="space-y-3 rounded-3xl bg-card p-3 shadow-sm">
      <div className="space-y-1 rounded-2xl bg-muted p-4">
        <h3 className="font-semibold">Problem</h3>
        <p className="whitespace-pre-wrap">{job.problem}</p>
        <div className="pt-2 text-muted-foreground">
          <p>Service: {job.service.name}</p>
          <p>System: {SYSTEM_TYPE_LABELS[job.systemType]}</p>
          {property.equipmentBrand && (
            <p>
              Equipment: {property.equipmentBrand}
              {property.equipmentYear && `, installed about ${property.equipmentYear}`}
            </p>
          )}
        </div>
        {job.vulnerableOccupant && (
          <p className="pt-1 font-medium text-red-700">
            Someone vulnerable is home without heat or cooling.
          </p>
        )}
        {photos.length > 0 && (
          <ul className="flex flex-wrap gap-2 pt-2">
            {photos.map((photo, index) => (
              <li key={photo.id}>
                <a
                  href={photo.url}
                  target="_blank"
                  rel="noreferrer"
                  className="block rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  <img
                    src={photo.url}
                    alt={`Homeowner’s upload ${index + 1}`}
                    className="size-20 rounded-lg object-cover"
                  />
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>

      <a
        href={mapsUrl(property)}
        target="_blank"
        rel="noreferrer"
        className={cn(ROW, 'outline-none focus-visible:ring-3 focus-visible:ring-ring/50')}
      >
        <Navigation className="mt-0.5 size-5 shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="block font-medium">{addressLine(property)}</span>
          {property.notes && (
            <span className="block text-muted-foreground">Access: {property.notes}</span>
          )}
        </span>
        <span className="shrink-0 text-xs font-medium text-primary">Open in Maps</span>
      </a>

      <div className={ROW}>
        <StickyNote className="mt-0.5 size-5 shrink-0" />
        {notes.length === 0 ? (
          <p className="text-muted-foreground">No notes yet.</p>
        ) : (
          <ul className="min-w-0 flex-1 space-y-2">
            {notes.map((note) => (
              <li key={note.id}>
                <p className="whitespace-pre-wrap">{note.body}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {note.authorName ?? 'AI receptionist'} ·{' '}
                  {noteTime.format(new Date(note.createdAt))}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-1 px-2 pt-2 pb-1">
        <h3 className="font-semibold">Charges</h3>
        <JobCharges job={job} charges={charges} />
      </div>
    </section>
  )
}
```

- [ ] **Step 4: Drop `PageShell` from the job route**

Replace `relay-web/src/routes/job.tsx` with:

```tsx
import { useParams } from 'react-router'
import { useMyJobsLiveUpdates } from '@/features/technician-jobs/api'
import { JobDetails } from '@/features/technician-jobs/job-details'

// One of the technician's jobs, opened from their list. The job page draws its own frame
// (brand band, back link, sign out). Texted job links (module 8, part 3) will get their own
// path.
export function JobPage() {
  const { jobId = '' } = useParams()
  useMyJobsLiveUpdates()

  return <JobDetails jobId={jobId} />
}
```

- [ ] **Step 5: Format, type-check, test, build**

Run: `npx biome check --write src/features/technician-jobs/job-header.tsx src/features/technician-jobs/on-the-way.tsx src/features/technician-jobs/job-details.tsx src/routes/job.tsx`
Run: `npm run typecheck`
Run: `npm test`
Expected: no errors; all tests pass.

---

### Task 4: Check it in the running app (controller, not a subagent)

- [ ] relay-api on :3000 and `npm run dev` in relay-web; open `http://desert.localhost:5173/sign-in/phone` at phone width (390×844) and sign in as a seeded technician.
- [ ] Booked job: band, hero card, Problem box, address row opens Maps, notes row, Charges; bottom bar shows `On my way` with `I’m already here · Running late · Can’t get in`.
- [ ] On my way → pick 15 min → on-the-way screen with ETA; `Job details` and `Back to directions` switch views; `I’m at the location` starts the job.
- [ ] In progress: Add repair → pick, quantity 2 → `Add repair · $X`; bottom button becomes `Review with homeowner · $X`; review sheet Approve → bottom button `Job complete`.
- [ ] Job complete → confirm → `Job done!` screen counts down and returns to `/jobs`.
- [ ] Reopen the done job: `Done at …`, no bottom bar.
