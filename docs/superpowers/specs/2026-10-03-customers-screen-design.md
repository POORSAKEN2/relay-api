# Customers screen: list, record, addresses with equipment, job history

Date: 2026-10-03. Status: approved design, waiting for the plan.

Part 1 of MVP module 7 ("Customers"): the customer record with address, phone, job history and
notes, and the simple equipment field (brand, approximate age). Part 2, spreadsheet import, gets
its own spec and builds on this one: imported customers land on this list, and import reuses the
contact and address rules defined here.

## Why

Today the office can only find a customer from inside the book-job dialog, and nothing can edit a
customer, an address or the equipment after the first booking. The job drawer and the technician
page already show equipment and access notes, but the office has no way to fill them in. During
a phone call the office needs one place that answers: who is this, where do they live, what
system do they have, what have we done for them, and is anything already booked.

## Decisions

- One piece of equipment per address. Keeps the existing `properties.equipment_brand` and
  `properties.equipment_year` columns, so there is no migration. A second unit goes in the
  address's access notes.
- Customer notes are one editable text field (the existing `customers.notes`), not a dated log.
- No delete and no merge in the MVP. The office edits records; duplicates are discouraged with a
  warning when a phone number is already in use.
- The record is its own page, `/customers/:id`, not a drawer.
- Each section saves on its own through a small dialog or inline editor, one endpoint each,
  matching the service and technician dialogs.
- A phone number is required for every customer, the same rule booking already uses.

## Out of scope

- Deleting or merging customers.
- More than one piece of equipment per address.
- A dated notes log with author and time.
- Showing text-consent status on the record.
- Customer history on the technician job page (module 8 lists it). A later change can reuse the
  job history query from this one.
- Audit rows for customer edits. The audit log covers consent, messages, payments, branding and
  job status changes.
- Spreadsheet import (part 2, separate spec).

## What the office sees

### Sidebar

A "Customers" link between Dispatch and Technicians, for owner and office. Icon: `Contact` from
lucide (`Users` is already Technicians).

### Customer list, `/customers`

```
┌──────────────────────────────────────────────────────────────────────┐
│ Customers                                          [+ Add customer]  │
│ ┌──────────────────────────────────────────────┐   Sort [Name A–Z ▾]│
│ │ Search  Name, phone or street              ✕ │                     │
│ └──────────────────────────────────────────────┘                     │
│ 1,240 customers                                                      │
│ ┌──────────────────────────────────────────────────────────────────┐ │
│ │ Maria Lopez   (480) 555-0199   1234 E Elm St, Phoenix   Next Oct 5│ │
│ │ Tom Reyes     (602) 555-0144   88 W Main St, Mesa  +1   Last visit Sep 12│ │
│ └──────────────────────────────────────────────────────────────────┘ │
│ Showing 1–25 of 1,240                              [‹ Prev] [Next ›] │
└──────────────────────────────────────────────────────────────────────┘
```

On a phone each row stacks: name with the visit label on the right, then phone, then address.

**Search.** One box. Matches when the name, a street or the email contains the text, or the phone
contains 3 or more of the typed digits. The search waits 250 ms after typing stops, has a clear
button, and keeps the previous results on screen while new ones load. On desktop the cursor starts
in the search box; on a phone it does not, so the keyboard doesn't open by itself. The box has a
visible label for screen readers (`Search customers`).

**URL state.** Search, sort and page live in the URL (`/customers?q=elm&sort=name&page=2`).
Back from a record returns to the same search and page, and the link can be shared. Missing or bad
values fall back to: empty search, sort by name, page 1.

**Sort.** Name A–Z (default) or Recently added (newest `created_at` first).

**Rows.** 25 per page. Each row is a single link to the record, with a large tap target and a
visible focus ring, and no buttons inside it. A row shows:

- the name
- the phone, formatted
- the first address as `street, city`, with "+1" (or "+2", …) when there are more
- on the right: "Next Oct 5" when an upcoming job exists, else "Last visit Sep 12, 2026", else
  "No visits yet"

Under the search: the count ("1,240 customers", or "3 matches"), announced to screen readers with
`aria-live="polite"`. Under the list: "Showing 26–50 of 1,240" and Prev / Next buttons. Changing
page scrolls back to the top.

**States.**

- Loading: five grey placeholder rows.
- Error: the message and a "Try again" button, styled like the Technicians page.
- No customers at all: "No customers yet. They appear here when someone books online, calls, or
  the office books a job." with an Add customer button. Part 2 adds an Import button here.
- No matches: "No customers match 'xyz'." with "Clear search" and "Add 'xyz' as a customer". The
  second opens the Add customer dialog with the name filled in, or the phone when the search was
  digits.

### Add customer and Edit contact dialog

One dialog component, used by Add customer (list) and Edit contact (record).

Fields: name (required, focused first), phone (required, `type="tel"`), email (optional,
`type="email"`). Add customer also shows an optional service address: street, unit, city, state,
ZIP. The address is all or nothing: once the street is filled in, city, state and ZIP are
required.

**Duplicate warning.** When the typed phone matches an existing customer, the dialog shows
"Maria Lopez already uses this number. Open that record" under the phone field, with a link to that
record. It does not block saving, because a household can share a phone. In Edit contact the
customer being edited doesn't count as a match. The check runs once the phone has 10 digits: it
reuses the list search with those digits, and a match is a result whose saved phone equals the
typed number (both as `+1` and 10 digits).

Saving: the button shows "Saving…" and is disabled. Errors appear next to their field and focus
moves to the first invalid one. On success Add customer shows the toast "Maria Lopez added" and
opens the new record; Edit contact closes and shows "Saved".

### Customer record, `/customers/:id`

```
Desktop (lg and up)                                Phone: one column
┌──────────────────────────────────────────────┐   header, notes, addresses, jobs
│ ‹ Customers                                  │
│ Maria Lopez            [Edit contact] [Book job]
│ (480) 555-0199 · maria@x.com  [Call] [Text]  │
│ Customer since Mar 2025 · from online booking│
├────────────────────────────┬─────────────────┤
│ Jobs (7)                   │ Notes     [Edit]│
│ Upcoming                   │ Prefers mornings│
│ Oct 5 · 8–10 AM            │                 │
│ AC tune-up · Luis  Booked  │ Addresses       │
│ Past                       │ 1234 E Elm St   │
│ Sep 12 · No cooling        │ Phoenix AZ 85004│
│ Diagnostic · Luis  Done    │ Equipment:      │
│ Jun 3 · Furnace check      │ Carrier · about │
│ Ana  Cancelled (greyed)    │ 12 years old    │
│                            │ Access: gate    │
│                            │ 4411, dog [Edit]│
│                            │ [+ Add address] │
└────────────────────────────┴─────────────────┘
```

**Header.**

- "‹ Customers" goes back to the list with the same search and page (browser history when the
  list was the previous page, else `/customers`).
- The name, the formatted phone, the email, and "Customer since Mar 2025 · from online booking".
  Source wording: booking → "from online booking", call → "from a phone call", office → "added by
  the office", import → "imported".
- Call and Text buttons (`tel:` and `sms:` links), as in the job drawer.
- Edit contact (secondary) opens the contact dialog.
- **Book job** (the page's one primary button) opens the existing book-job dialog with this
  customer already picked and the first address selected, on today's date. After booking, the
  dialog closes, its existing "Booked …" toast shows, and the job history refreshes so the new
  job appears under Upcoming.

**Notes.** Edited in the card itself: Edit turns the text into a text box with Save and Cancel.
Escape cancels, Ctrl+Enter saves. Line breaks are kept. Limit 2000 characters; a counter appears
in the last 200. Empty text saves as no notes. When there are none: "No notes. Add things like
'prefers mornings' or 'pays by check'." On a phone the notes sit right under the header, so
warnings are seen during a call.

**Addresses.** One block per address, oldest first:

- street and unit, then city, state and ZIP
- "Equipment: Carrier · about 12 years old", or "Equipment: Not recorded"
- "Access: gate code 4411, dog in yard" when there are access notes
- an Edit button

"+ Add address" under the last block.

**Address dialog** (add and edit):

- Address fields, shared with the book-job dialog.
- Equipment brand: free text with suggestions (a `datalist`): Amana, American Standard, Bryant,
  Carrier, Daikin, Goodman, Lennox, Mitsubishi, Rheem, Ruud, Trane, York. Up to 50 characters.
- Equipment age: "About [ 12 ] years old", a whole number from 0 up to this year minus 1950, with
  a live hint "≈ installed 2014". Empty means unknown.
- Access notes: "Gate code, pets, attic access". Up to 1000 characters.
- In edit mode, a hint under the address: "Customer moved? Add a new address instead, so past
  jobs keep the old one." (Jobs point at the address, so editing it changes the address shown
  on every past job there. Editing is for fixing typos.)

**Job history.**

- Title "Jobs (7)".
- Upcoming jobs first (soonest first), then past jobs (newest first), under "Upcoming" and "Past"
  labels. A section with no jobs is not shown.
- Each row: the date and arrival window, the service name and the problem, the technician (or
  "Unassigned"), and the status badge from dispatch's existing `STATUS` labels. The street shows
  only when the customer has more than one address. Cancelled jobs are greyed.
- `held` and `expired` jobs (abandoned booking attempts) are left out.
- Clicking a row opens the existing `JobDrawer` over the page. Closing it refreshes the history.
- No jobs: "No jobs yet."
- At most 100 jobs; when there are more, "Showing the latest 100 jobs" at the bottom.

**States.**

- Loading: grey placeholder header and cards.
- Not found (wrong id, or another contractor's customer): "Customer not found" with a link back
  to the list.
- Every save: the button shows "Saving…", errors appear next to their field, success closes the
  dialog or editor and shows the toast "Saved".

### Equipment wording everywhere

The record, the job drawer and the technician job page all show equipment the same way, from one
helper:

| Brand | Install year (in 2026) | Shown |
|---|---|---|
| Carrier | 2014 | Carrier · about 12 years old |
| Carrier | 2026 | Carrier · less than a year old |
| Carrier | 2025 | Carrier · about 1 year old |
| Carrier | none | Carrier |
| none | 2014 | About 12 years old |
| none | none | Not recorded (record page only; the drawer and technician page hide the line) |

## API

All routes are in the existing `customers` module, for owner and office (`requireRole('owner',
'office')`), and every query takes the tenant id first.

| Route | Body or query | Returns |
|---|---|---|
| `GET /customers` | `q` (0–100 chars), `sort` (`name` or `newest`, default `name`), `page` (default 1) | `{ customers, total, pageSize }` |
| `POST /customers` | `{ name, phone, email?, property? }` | 201 `{ id }` |
| `GET /customers/:customerId` | | `{ customer, properties, jobs }` |
| `PATCH /customers/:customerId` | any of `{ name, phone, email, notes }`, at least one | 200 `{ customer }` |
| `POST /customers/:customerId/properties` | `{ street, unit?, city, state, zip, equipmentBrand?, equipmentYear?, notes? }` | 201 `{ property }` |
| `PUT /customers/:customerId/properties/:propertyId` | same body as POST | 200 `{ property }` |

`GET /customers` list item:

```ts
{
  id, name, phone, email,
  // oldest first; the same address shape as the record page
  properties: [{ id, street, unit, city, state, zip, equipmentBrand, equipmentYear, notes }],
  lastVisitDate: string | null, // local day in the contractor's timezone, '2026-09-12'
  nextVisitDate: string | null, // local day, '2026-10-05'
}
```

`pageSize` (25) comes from the API, so the web app never repeats it.

The book-job dialog keeps using this route for its search. It ignores the new fields, and its
own rule of searching only after 2 typed characters stays in the web app; the server no longer
returns an empty list for short searches, because the list page needs "everyone" for an empty
search.

`GET /customers/:customerId`:

```ts
{
  customer: { id, name, phone, email, notes, source, createdAt },
  properties: [{ id, street, unit, city, state, zip, equipmentBrand, equipmentYear, notes }],
  jobs: [{
    id, status, upcoming, propertyId,
    date,        // local day, '2026-10-05'
    dateLabel,   // 'Oct 5, 2026'
    windowLabel, // local arrival window, '8–10 AM'
    serviceName, problem,
    technicianName, // null when unassigned
  }],
  jobsTotal, // to show "Showing the latest 100 jobs"
}
```

Errors:

- Validation fails: 400 with field messages, through the existing error handler.
- Customer not found, or another contractor's: 404 "Customer not found".
- Address not found, or not this customer's: 404 "Address not found".
- Two people editing the same record: the last save wins.

## Rules, each in one place

- **Search** (`customers.queries`): name, any of the customer's streets, or the email contains the
  text (case ignored, `%` and `_` typed literally); or the phone contains the typed digits when
  there are 3 or more. Used by the list, the book-job search and the duplicate-phone check.
- **Upcoming job** (`customers.queries`, one SQL expression): status is `booked`, `en_route` or
  `in_progress` and the window has not ended. Used for `nextVisitDate` and the history's `upcoming`.
- **Last visit:** the newest `completed_at` among the customer's `done` jobs.
- **History:** all jobs except `held` and `expired`. Dates and window labels in the contractor's
  timezone, using dispatch's `local()` helper.
- **Contact and address fields** (`customers.schemas.ts`, new): `NewCustomer` and `NewProperty`
  move here from `booking.schemas.ts`, and booking imports them. New field rules:
  - `notes` (customer): up to 2000 characters, blank becomes null
  - `equipmentBrand`: up to 50 characters, blank becomes null
  - `equipmentYear`: whole number from 1950 to the current year, or null
  - `notes` (address): up to 1000 characters, blank becomes null
- **Equipment age:** the database keeps the install year, so the age grows on its own. The web
  app turns the typed age into a year (`installYear(age)`) and a year back into words
  (`equipmentLabel(brand, year)`), both in `relay-web/src/lib/equipment.ts`.
- New customers made from this screen get `source = 'office'`.

## Code layout

### relay-api

- `modules/customers/customers.schemas.ts`: new. Contact, address, list query, patch and
  property bodies.
- `modules/customers/customers.queries.ts`: list with counts and visit dates, detail, history,
  update customer, update property.
- `modules/customers/customers.service.ts`: list, create (customer and optional address in one
  transaction), detail, update, add and replace address.
- `modules/customers/customers.routes.ts`: the six routes.
- `modules/booking/booking.schemas.ts`: imports `NewCustomer` and `NewProperty` from customers.

### relay-web

- `features/customers/api.ts`: query and mutation hooks for the routes above.
- `features/customers/contact-dialog.tsx`: Add customer and Edit contact, with the duplicate
  warning.
- `features/customers/property-dialog.tsx`: address, equipment and access notes.
- `features/customers/notes-card.tsx`: inline notes editor.
- `features/customers/job-history.tsx`: upcoming and past jobs, opens `JobDrawer`.
- `features/customers/list-params.ts`: reads and writes `q`, `sort`, `page` from the URL, with
  fallbacks.
- `routes/customers.tsx` (list) and `routes/customer.tsx` (record), added to `router.tsx`.
- `components/sidebar.tsx`: the Customers link.
- `components/address-fields.tsx`: new, moved out of `book-job-dialog.tsx`, used by both dialogs.
- `lib/equipment.ts`: `installYear`, `ageFrom` and `equipmentLabel`. The job drawer and
  technician job page switch to `equipmentLabel`.
- `lib/address.ts`: the blank address form and `addressStarted()` (the all-or-nothing rule).
- `lib/use-debounced.ts`: moved out of `book-job-dialog.tsx`, used by the list search too.
- `lib/format.ts`: adds `usPhoneDigits()` for the duplicate-phone check.
- `features/customers/labels.ts`: visit, count, range, "customer since" and source wording.
- `components/form-field.tsx`: adds `focusFirstInvalid()`.
- `features/dispatch/book-job-dialog.tsx`: an optional `customer` prop that starts the form
  with that customer and their first address picked. The dispatch board's use is unchanged.

relay-api also adds `formatDate()` ('Sep 12, 2026') to `lib/labels.ts` for the history rows.

Dependencies run one way: `customers` uses `dispatch` (`JobDrawer`, `BookJobDialog`, `STATUS`),
and `dispatch` never imports `customers`. Dispatch keeps its own `useCustomerSearch` hook.

## Testing

### API (`customers.test.ts`, real test database, supertest)

- List: search by name, street, email and phone digits; empty search returns everyone; both
  sorts; paging and `total`; `nextVisitDate` ignores cancelled and past jobs; `lastVisitDate` uses
  `done` jobs only; other contractors' customers never appear.
- Create: contact only; contact with address; a street without city, state or ZIP is refused;
  a bad phone gives a field error; `source` is `office`.
- Detail: properties and jobs; `held` and `expired` left out; upcoming first, then newest first;
  404 for another contractor's customer.
- Update: contact only; notes only; blank notes become null; notes over 2000 characters refused.
- Addresses: add; replace; equipment year before 1950 or after this year refused; another
  customer's address gives 404.
- Booking regression: existing booking tests pass after the schema move; the existing
  `GET /customers` test is updated for the new response.

### Web (pure functions, like the existing web tests)

- `lib/equipment.test.ts`: age to year; every row of the equipment wording table.
- `features/customers/list-params.test.ts`: good values, missing values, bad sort, page 0 and
  non-numbers fall back.

### By hand (headless Edge)

- The list at desktop and phone widths.
- Search, open a record, Back restores the search and page.
- No matches, then "Add 'xyz' as a customer".
- Duplicate phone warning in Add customer and Edit contact.
- Edit notes, an address and its equipment; the job drawer shows the new equipment wording.
- Open a past job from the history in the drawer.
- Book job from the record; the new job shows under Upcoming.
