# Bug: online bookings never emit `booking.priority`

Found: 2026-10-05, while planning office alerts
(`docs/superpowers/specs/2026-10-05-office-alerts-design.md`).
Severity: low. Nothing a user sees is wrong today. It is a trap for the next feature that
listens to the event.
Status: fixed 2026-10-05 with `announceBooking()`, as described under Fix below.

## What happens

The API has a realtime event for priority jobs, `booking.priority`
(`src/realtime/events.ts`). Only one of the two booking paths sends it.

| Booking path | `booking.created` | `booking.priority` |
|---|---|---|
| Office: `bookForOffice()` in `src/modules/booking/booking.service.ts` | yes | yes, when `job.priority` |
| Online: `bookVisit()` in `src/modules/online-booking/online-booking.service.ts` | yes | **never** |

```ts
// booking.service.ts → bookForOffice()
const change = { jobId: job.id, dates: [input.date] }
emitToTenant(tenantId, 'booking.created', change)
if (job.priority) emitToTenant(tenantId, 'booking.priority', change)

// online-booking.service.ts → bookVisit()
emitToTenant(tenant.id, 'booking.created', { jobId: job.id, dates: [input.date] })
// no booking.priority, even when job.priority is true
```

An online job is priority when the homeowner says a vulnerable person has no heat or cooling,
or pays the priority fee (`priority: input.vulnerableOccupant || priorityFeeCents > 0`).

## Why nobody has noticed

relay-web never listens to `booking.priority`. It is typed in `relay-web/src/lib/socket.ts`
but has no `useSocketEvent('booking.priority', …)`. The dispatch board refreshes on
`booking.created` (`useDispatchLiveUpdates()` in `relay-web/src/features/dispatch/api.ts`) and
reads the priority flag from the job data. So a priority web booking still shows as priority
on an open board.

The tests match the code: `booking.test.ts` checks the office path sends `booking.priority`,
and `online-booking.test.ts` only checks `booking.created`.

## Why it matters

The first screen that does listen to `booking.priority`, for example a sound or a banner for
priority jobs, will work for office bookings and do nothing for online ones. Online bookings
are the ones that need it most: a homeowner booking at night with nobody watching the board.
Nothing would fail; the event just never arrives, which is hard to debug.

A third booking path is coming (the AI receptionist, module 4). Copying the two emit lines
into each path makes the same mistake likely again.

## Fix

Send the booking events from one function that every booking path calls, so they can't drift
apart.

1. In `src/modules/booking/booking.service.ts`:

   ```ts
   // Tells open dashboards about a new booking. Every way of booking calls this after its
   // transaction commits, so all of them send the same events.
   export function announceBooking(
     tenantId: string,
     job: { id: string; priority: boolean },
     date: string,
   ) {
     const change = { jobId: job.id, dates: [date] }
     emitToTenant(tenantId, 'booking.created', change)
     if (job.priority) emitToTenant(tenantId, 'booking.priority', change)
   }
   ```

2. `bookForOffice()`: replace its three emit lines with
   `announceBooking(tenantId, job, input.date)`.
3. `bookVisit()`: replace its emit line with `announceBooking(tenant.id, job, input.date)`.
   `job` already has `priority`: `insertJob()` returns it.
4. Emit after the transaction commits, as both paths already do. Don't move the call into
   `insertBookedJob()`: that runs inside the transaction, so a booking that rolls back would
   still be announced.

### Tests

- `online-booking.test.ts`: a booking with `vulnerableOccupant: true` emits `booking.priority`
  with `{ jobId, dates: [date] }`; an ordinary booking doesn't.
- Same for one with `priorityService: true` and a contractor priority fee above 0.
- `booking.test.ts`: the existing office tests should pass unchanged.

## Another option

Delete `booking.priority` from `src/realtime/events.ts` and `relay-web/src/lib/socket.ts`,
since nothing listens to it. It's less code, but whoever builds the priority banner then has
to add the event back and get both paths right. The fix above costs about 10 lines, so it's
the recommended one.
