# Job repairs: a price list, repairs on the job, and the homeowner's approval

Date: 2026-10-02. Status: approved design, waiting for the plan.

Part 5, step 1 of MVP module 8 ("Technician job page": "adds the repair from the price list").
The technician adds repairs from the contractor's price list to a job in progress, and the
homeowner approves or declines the price on the technician's phone before the work starts.

Builds on the technician status buttons (`2026-10-02-technician-status-buttons-design.md`).

## Steps of part 5

1. **Repairs and approval** (this spec): the price list, the job's lines, the homeowner's yes
   or no.
2. **Finish & invoice**: "Job complete" becomes one step that issues the invoice from the
   approved lines and marks the job done. A job can't be done without an invoice; the rule
   lives in `changeStatus()`, so the office's "Mark done" follows it too. Done doesn't wait
   for payment.
3. **Payments** (module 9): charge the card on file or text a payment link.

## Decisions

| Question | Decision |
|---|---|
| How the homeowner decides | On the technician's phone, in person: an "Approve" / "Decline" screen the technician hands over. Recorded with the time and "decided in person". |
| What the technician can add | Repairs from the contractor's price list only, with a quantity of 1 to 20. Prices come from the list; no custom lines. |
| The diagnostic fee | Always charged. Total = booked service + priority fee (if chosen) + approved repairs. Crediting it against a repair can be a contractor setting later. |
| The booked service and priority fee | Become job lines too, written when the job is booked, with the price frozen then. The invoice (step 2) is the sum of approved lines. |
| Approved lines | Locked: they can't be removed or changed. More repairs can be proposed later, which needs another decision. |

## Out of scope

The invoice and "Finish & invoice" (step 2), payments (step 3), crediting the diagnostic
fee, custom lines, discounts, taxes, the homeowner approving from their own phone by text
(waits for real texting), editing a line's quantity after adding it (remove and add again).

## What people see

### Office: repair prices

A **Repair prices** section on the Services screen: the contractor's price list, alphabetical,
each with its name and price, and **Add**, **Edit**, **Archive** / **Restore** (same pattern
as services). Archived prices leave the technician's picker; jobs that used them keep their
line. The demo seed adds: Capacitor replacement $185, Contactor replacement $165, Refrigerant
(per lb) $95, Condenser fan motor $425, Thermostat replacement $210, Drain line flush $120.

### Technician: Charges on the job page

A **Charges** section lists the job's lines:

- the booked service, already agreed: `AC repair (diagnostic fee)` · $89;
- `Priority service` with its fee, when the homeowner chose it;
- repairs: description, quantity and line total, with their state (waiting for the homeowner,
  approved, or declined and struck through).

At the bottom: "Approved so far: $X".

While the job is **In progress**:

- **Add repair**: a sheet with the price list (name and price) and a quantity (1–20). The
  repair is added as waiting for the homeowner. A waiting repair has a remove button.
- **Review with homeowner** (shown when repairs are waiting): a full-screen sheet to hand
  over, with every line, "Total if approved: $X", and two big buttons: **Approve $X** and
  **Decline repairs**, plus a small **Not now** that closes it and records nothing. Approve
  marks every waiting repair approved; Decline marks them declined.

### Office: the job drawer

Shows the same lines with their state and the approved total, read-only, updated live.

## Data

The tables exist (`price_items`, `job_items`); no columns change.

- A job's **booked lines**, written in the transaction that books it, status `approved`,
  `price_item_id` null:
  - the service: description `<service name>` (fixed price), `<service name> (diagnostic fee)`
    (diagnostic) or `<service name> (free)` at $0 (free), unit price = the service's price
    (0 when free), quantity 1;
  - when `priority_fee_cents > 0`: `Priority service` at that fee, quantity 1.
- **Repairs**: `price_item_id` set, description and unit price copied from the price item when
  added, status `proposed`, then `approved` or `declined`; `created_by` = the technician.
- **Migration `0008_job_booked_lines`**: for every job without lines, adds its booked lines by
  the same rules (from the service's current price, the best value available for old jobs).

## API

### Modules

- `catalog` gains repair prices (`price_items`), next to services.
- A new `charges` module owns `job_items`: adding booked lines, proposing and removing
  repairs, the decision, and totals. It depends on no other module (it reads and locks the
  job's status with its own small query).
- `booking`, `dispatch` and `technician-jobs` call `charges`; `charges` never calls them.
- Both booking paths (the office's `bookForOffice()` and online `bookVisit()`) go through a new
  `insertBookedJob()` in `booking.service.ts`, which inserts the job and calls
  `charges.addBookedLines()` in the same transaction.

### Routes

| Who | Route | Body | Answer |
|---|---|---|---|
| Office | `GET /api/price-items` | — | `{ priceItems: [{ id, name, priceCents, archived }] }`, active first, then by name |
| Office | `POST /api/price-items` | `{ name, priceCents }` | `201 { priceItem }` |
| Office | `PATCH /api/price-items/:id` | `{ name, priceCents }` | `{ priceItem }` |
| Office | `POST /api/price-items/:id/archive`, `/restore` | — | `{ priceItem }` |
| Technician | `GET /api/my-jobs/price-items` | — | `{ priceItems: [{ id, name, priceCents }] }`, active only, by name |
| Technician | `POST /api/my-jobs/:jobId/repairs` | `{ priceItemId, quantity }` | the refreshed job page |
| Technician | `DELETE /api/my-jobs/:jobId/repairs/:itemId` | — | the refreshed job page |
| Technician | `POST /api/my-jobs/:jobId/repairs/decision` | `{ decision: 'approved' \| 'declined' }` | the refreshed job page |

Price item input: name trimmed, 1 to 100 characters ("Enter a name"); price in cents, a whole
number from 0 to 1,000,000 ("Enter a price from $0 to $10,000"). Another contractor's price
item answers 404 "That price isn’t on your list."

The technician job page (`GET /api/my-jobs/:jobId`) and the office drawer (`GET
/api/jobs/:jobId`) gain:

```
charges: {
  lines: [{ id, description, quantity, unitPriceCents, totalCents, status, removable }],
  approvedTotalCents,   // sum of approved lines
  proposedTotalCents,   // sum of lines waiting for the homeowner
}
```

Lines are ordered booked lines first, then repairs by when they were added. `removable` is
true for a proposed repair.

### Rules (in `charges`)

- Repairs can be added and removed only while the job is `in_progress`: otherwise `422
  invalid_transition` "Start the job before adding repairs.".
- An archived or unknown price item: `422 not_on_list` "That price isn’t on the list
  anymore.".
- Only proposed repairs can be removed: an approved or declined line, or a booked line,
  answers `422 locked` "Only repairs waiting for the homeowner can be removed."; a line that
  isn't on this job answers `404`.
- The decision applies to every proposed line at once. None proposed: `422 nothing_to_decide`
  "There are no repairs waiting for the homeowner.".
- The technician routes check the job is the technician's first (`404` "This job isn’t
  assigned to you anymore.").
- Audit events, actor the technician: `job.repair_proposed` (`{ itemId, description,
  quantity, unitPriceCents }`), `job.repair_removed` (`{ itemId }`), `job.repairs_approved` /
  `job.repairs_declined` (`{ itemIds, totalCents, how: 'in_person' }`). Office price list
  changes write `price_item.added`, `price_item.updated`, `price_item.archived`,
  `price_item.restored`.
- A new live event `job.charges_changed` (`{ jobId, dates }`) after each change; the office's
  drawer and board and the technician's pages reload on it.

## Web

- `features/catalog`: price item hooks and a **Repair prices** section on the Services screen
  (list, add/edit dialog, archive/restore), dollars in the form, cents in the API.
- `features/technician-jobs`: the Charges section, the Add repair sheet, the review sheet.
- `features/dispatch`: the Charges block in the job drawer.
- One money formatter for the app, `formatMoney(cents)` → `$1,234.50` / `$89`, used by the new
  screens.
- Both the office's and the technician's live-update hooks also listen to `job.charges_changed`.

## Errors

- A 422 (job not in progress anymore, price archived, nothing to decide): the API's message in
  a toast, and the page reloads.
- Network failure: "Couldn’t update the job. Check your connection and try again.".
- The review sheet's buttons are disabled while saving.

## Testing

- API:
  - repair prices: add, edit, archive, restore, validation messages, office only, another
    contractor's invisible;
  - booked lines: an online and an office booking each get the service line (fixed,
    diagnostic, free) and the priority line when chosen;
  - repairs: adding copies the price and keeps the quantity; refused when the job isn't in
    progress or the price is archived; only proposed repairs can be removed;
  - decision: approve and decline set the statuses and totals; nothing to decide → 422;
  - audit events and `job.charges_changed`; another technician's job 404; office 403 on the
    technician routes;
  - the office drawer and the technician job page carry `charges`.
- The migration: after it runs on the development database, every job has its booked line.
- Web: `formatMoney()`.
- In the running app: the office adds a price; Sam adds two repairs to an in-progress job;
  the homeowner approves on Sam's screen; the office drawer shows the new total live.
