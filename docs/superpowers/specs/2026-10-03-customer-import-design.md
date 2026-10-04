# Customer import from a spreadsheet

Date: 2026-10-03. Status: approved design, waiting for the plan.

Part 2 of MVP module 7 ("Customers"): "Spreadsheet import on day one". Builds on part 1,
`2026-10-03-customers-screen-design.md` (the customer list, record page and the contact and
address rules in `customers.schemas.ts`).

## Why

A pilot shop already has its customers somewhere: an Excel file, a Google Sheet, or an export
from its old software. Retyping hundreds of customers by hand would stop a pilot on day one.
The office needs to bring that list in themselves, see exactly what will happen before anything
is saved, and take it back if they got it wrong, because the MVP has no way to delete customers
one by one.

## Decisions

- The owner or office runs the import themselves from the Customers screen. The Relay team
  doesn't need a separate tool.
- Files: `.csv` and `.xlsx`.
- Columns are guessed from the file's headings and the office can correct every guess before
  checking.
- A row that matches a customer Relay already has (same phone and same name) is skipped and
  reported. Existing records are never changed by an import.
- No texting consent is recorded for imported customers. They give consent the normal way the
  next time they book.
- Every import is saved as a batch that can be undone.
- The browser reads the file; the API checks and saves the rows. No file is uploaded or stored.

## Out of scope

- Importing other software's export formats as such (ServiceTitan, Housecall Pro, Jobber):
  Phase 2. Their files still work here as ordinary spreadsheets.
- Recording texting consent at import.
- Updating or merging existing customers from a file.
- Importing jobs, service history, or more than one address per row.
- Files with more than 5,000 rows, and background-job imports.
- Importing from a Google Sheets link (download the sheet as `.xlsx` or `.csv` first).
- Storing the uploaded file.

## What the office sees

### Entry points

- **Import** (secondary button) next to **Add customer** in the Customers list header.
- **Import a spreadsheet** next to **Add customer** in the list's "No customers yet" state.

Both open `/customers/import`, a page of its own with four steps:

```
Import customers            ① File  ② Columns  ③ Check  ④ Done
```

The step bar shows where the office is. Steps can't be skipped ahead, and the bar can't be used
while a step is working. Leaving the page drops the unsaved import; nothing is saved before step
③'s import button.

### ① File

- A drop zone with a **Choose file** button. Accepts `.csv` and `.xlsx`.
- Help text: "Export your customer list from Excel, Google Sheets or your old software: one
  customer per row, with a heading row."
- An `.xlsx` with more than one sheet starts with its first sheet; step ② has a sheet picker
  to choose another (changing sheet guesses the columns again).
- Limits: 5 MB and 5,000 rows (not counting the heading row and blank rows).
- Errors, shown under the drop zone:
  - not a `.csv` or `.xlsx`, or unreadable: "This file couldn't be read. Save it as .xlsx or
    .csv and try again."
  - too big: "This file is over 5 MB. Split it into smaller files."
  - too many rows: "This file has 7,200 rows. Split it into files of up to 5,000."
  - no rows under the heading: "This file has no customers under the heading row."
- **Past imports** under the drop zone: the latest 20, each with the date, who ran it, the file
  name, how many customers it added, and an **Undo** button (or "Undone Oct 4 · 3 kept (have
  jobs)" once undone). Hidden when there are none.

### ② Columns

One line per Relay field, each with a dropdown of the file's columns plus **Don't import**,
already set to Relay's guess. Next to each dropdown, a sample value from the first non-empty
cell of that column ("e.g. Maria Lopez"), so a wrong guess is easy to spot.

| Relay field | Headings it recognises |
|---|---|
| Name (or first name) | name, customer, customer name, full name, client, client name, contact, contact name, first name, first |
| Last name (if separate) | last name, last, surname, family name |
| Phone | phone, phone number, mobile, mobile phone, cell, cell phone, telephone, tel, primary phone |
| Email | email, e-mail, email address |
| Street | address, street, street address, address 1, address line 1, service address |
| Unit | unit, apt, apartment, suite, address 2, address line 2 |
| City | city, town |
| State | state, st, province |
| ZIP | zip, zip code, postal code, postcode |
| Address (one column) | used instead of the five above; see below |
| Equipment brand | brand, equipment, equipment brand, system brand, make |
| Equipment age or install year | install year, year installed, installed, equipment year, equipment age, system age, age |
| Access notes | gate code, access, access notes |
| Customer notes | notes, note, comments, memo |

- Headings are compared with case, spaces and punctuation ignored ("E-mail Address" is
  "email address").
- Each file column is guessed for at most one field. When several columns could be the phone,
  one whose heading says mobile or cell wins.
- Address: a choice at the top of the address group, **Separate columns** (Street, Unit, City,
  State, ZIP) or **One column** (one dropdown, for values like "12 Palm St, Phoenix, AZ 85004").
  Relay picks **One column** to start when no City, State or ZIP heading was recognised but an
  address heading was.
- Name and Phone are required; **Check rows** stays disabled until both have a column.
- Under the list: "Not imported: Balance, Last service date", the file's columns no field uses,
  so nothing is dropped without the office seeing it.

### ③ Check

The API checks every row without saving anything. While it works the button says "Checking
1,240 rows…".

- Counts at the top, each a filter for the table: **1,180 ready · 42 already in Relay · 6
  repeated in this file · 12 need fixing**.
- A table of rows: the row's number in the file, name, phone, address (one line), and a status
  chip with the reasons ("Phone isn't a 10-digit US number", "Street without a ZIP code").
  On a phone the table becomes stacked cards.
- Only ready rows are imported. Rows that need fixing, are already in Relay, or are repeated are
  skipped as a whole, never half-imported.
- **Download rows to fix** (shown when any row needs fixing): a `.csv` of those rows with the
  file's original columns plus a "Problem" column, to fix and import later.
- **Back to columns** returns to step ② with the choices kept.
- The main button: **Import 1,180 customers**, disabled when nothing is ready.

### ④ Done

- "1,180 customers imported. 42 were already in Relay, 6 were repeated in the file, 12 need
  fixing." (Only the parts that aren't zero.)
- **View customers** opens the list sorted by Recently added.
- **Undo this import** opens a confirm dialog: "Remove the 1,180 customers this import added?
  Anyone you've booked a job for since then stays. Changes made to the others since the import
  are lost." Confirm shows "Removed 1,177 customers. 3 kept because they have jobs."
- **Import another file** goes back to step ①.

### States

- Every step's button shows its work ("Reading file…", "Checking 1,240 rows…", "Importing…").
- A failed request shows its message inline with **Try again**; the office's choices are kept.
- Desktop-first (offices import at a computer), and still usable at phone width with no
  sideways scroll.

## Row rules

The web app only picks which cell goes to which field and sends the cell text. The API reads and
validates every value, so each rule exists once.

- **Name:** the name cell, plus " " and the last-name cell when one is matched; trimmed, extra
  spaces removed. Required, at most 200 characters.
- **Phone:** the same rule as everywhere (`UsPhone`): 10 digits, an optional leading 1, any
  punctuation. A phone Excel stored as a number is read as its digits. Required.
- **Email:** the same rule as everywhere. Optional.
- **Address:** all or nothing, the same as Add customer: a started address needs street, city,
  state and ZIP.
  - State: a 2-letter code, or a full US state or DC name ("Arizona" → AZ).
  - ZIP: "85004-1234" → 85004; a 4-digit ZIP gets its leading 0 back ("2134" → 02134).
  - One column: split on commas as `street[, unit], city, ST ZIP` (the state and ZIP may also
    be two separate comma parts). Anything that doesn't fit needs fixing.
- **Equipment brand:** at most 50 characters. Optional.
- **Equipment age or install year:** a 4-digit year from 1950 to this year is the install year;
  a whole number from 0 to 75 is an age (install year = this year − age); a date such as
  "5/1/2014" or "2014-05-01" uses its year. Anything else needs fixing. Optional.
- **Access notes:** at most 1,000 characters. **Customer notes:** at most 2,000. Optional.
- Blank cells are fine for optional fields. A row whose matched cells are all blank is skipped
  and not counted. The first non-empty row of the sheet is the heading row.

A row is **ready** when every matched value reads correctly, and **needs fixing** otherwise.
There is no third outcome: if a whole column is unreadable, the office sets it to **Don't
import** in step ②.

### Duplicates

- **Already in Relay:** a customer of this contractor with the same phone and the same name,
  ignoring case and extra spaces. This is the same rule online booking uses to find a returning
  customer.
- **Repeated in this file:** the same phone and name as an earlier row in the file; the later
  row is skipped.
- Same phone, different name (a household sharing a phone): both are imported.

## API

All routes are in the `customers` module, for owner and office (`requireRole('owner',
'office')`), tenant-scoped like the rest.

| Route | Body | Returns |
|---|---|---|
| `POST /customers/imports/check` | `{ addressInOneColumn, rows }` | `{ rows: [{ row, status, problems }], counts }` |
| `POST /customers/imports` | `{ fileName, addressInOneColumn, rows }` | 201 `{ importId, created, existing, repeated, invalid }` |
| `GET /customers/imports` | | `{ imports: [{ id, fileName, createdByName, createdCount, skippedCount, createdAt, undoneAt, keptCount }] }` |
| `POST /customers/imports/:importId/undo` | | `{ removed, kept }` |

- A row is `{ row, name?, lastName?, phone?, email?, street?, unit?, city?, state?, zip?,
  address?, equipmentBrand?, equipmentAge?, accessNotes?, notes? }`: `row` is its line number
  in the file (for the office to find it), every other field is the cell text. At most 5,000
  rows; each text at most 2,000 characters.
- `status` is `ready`, `existing`, `repeated` or `invalid`; `problems` lists the reasons for
  `invalid` in the office's words; `counts` has one number per status.
- `POST /customers/imports` runs the same check again inside its transaction instead of trusting
  the preview, then saves the ready rows. If nothing is ready it returns 422 "Nothing to
  import: no row is ready." and saves nothing.
- Undo: 404 "That import wasn’t found." for a missing or other contractor's import; 409 "This
  import was already undone." the second time.
- The two import POST routes accept JSON bodies up to 5 MB; every other route keeps the
  default limit.

### Data

One migration:

- New table `customer_imports`: `id`, `tenant_id`, `created_by` (the user, composite FK like the
  other tables), `file_name`, `created_count`, `skipped_count`, `kept_count` (null until undone),
  `created_at`, `undone_at` (null until undone). Unique on `(tenant_id, id)`.
- New nullable column `customers.import_id`, with a composite FK `(tenant_id, import_id)` to
  `customer_imports(tenant_id, id)`.

Saving:

- One transaction: insert the `customer_imports` row, then the ready customers (`source =
  'import'`, `import_id` set) in chunks of 500, then their addresses with equipment and access
  notes.
- No `consent_events` rows. No texts are sent.

Undo:

- One transaction. Deletes the batch's customers and their addresses, except customers that now
  have any job, call, message, waitlist entry or saved payment method. Those are kept and
  counted.
- Sets `undone_at` and `kept_count`.

### Rules, each in one place

- **Reading rows** (`customers/import-rows.ts`, new, pure functions with tests): name joining,
  the state-name table, ZIP clean-up, one-column address splitting, age/year/date to install
  year, and turning a row into a valid customer and address or a list of problems. It reuses
  `NewCustomer`, `NewProperty`, `UsPhone`, `UsState`, `Zip` and `OptionalEmail` rather than
  repeating them.
- **Same customer** (`customerMatchKey(phone, name)`, new, in `customers/customer-match.ts`):
  returns `"+16025550111|maria lopez"` (the E.164 phone, then the name lower-cased, trimmed,
  with runs of spaces made one). Two customers are the same when their keys are equal; this is
  the only definition. `findCustomerByPhoneAndName`, used by online booking, changes from its
  SQL name comparison to "find by phone, oldest first, then keep the first whose key matches",
  so both paths share it. The import fetches all of the file's phones in one query and compares
  keys in a `Set`.

## Code layout

### relay-api

- `src/db/schema.ts` and a new migration: `customer_imports`, `customers.import_id`.
- `src/modules/customers/import-rows.ts` (+ `import-rows.test.ts`): row reading and validation.
- `src/modules/customers/customer-match.ts` (+ test): `customerMatchKey`.
- `src/modules/customers/customers.queries.ts`: `findCustomerByPhoneAndName` switched to
  `customerMatchKey`.
- `src/modules/customers/imports.queries.ts`, `imports.service.ts`, `imports.routes.ts`,
  `imports.schemas.ts` (+ `imports.test.ts`): the import flow, kept apart from the customer
  screens' files so neither grows too large. Same module, same layers.
- `src/app.ts`: mount the import routes' 5 MB JSON parser before the default parser, so the
  larger limit applies to those two POST routes only.

### relay-web

- New dependencies: `papaparse` (CSV) and `read-excel-file` (`.xlsx`), loaded only by the import
  page.
- `src/features/customers/import/read-file.ts`: a file to a grid of text cells, per sheet.
- `src/features/customers/import/guess-columns.ts` (+ test): headings to fields.
- `src/features/customers/import/to-rows.ts` (+ test): grid and column choices to API rows.
- `src/features/customers/import/problem-rows.ts` (+ test): the "rows to fix" CSV.
- `src/features/customers/import/` step components and api hooks.
- `src/routes/customers-import.tsx`, its router entry, and the **Import** buttons on the list.

Dependencies stay one way: the import code lives in the `customers` feature and module.

## Testing

### API

- `import-rows.test.ts` (pure): name joining; phone variants (punctuation, leading 1, digits
  from an Excel number); email; all-or-nothing address; state names; ZIP+4 and a lost leading 0;
  one-column addresses with and without a unit, and ones that don't fit; age, year and date to
  install year, and unreadable values; over-long notes.
- `customer-match.test.ts` (pure): same key ignoring case and extra spaces; different phone or
  name gives a different key.
- `imports.test.ts` (real test database):
  - check returns each row's status and problems, the counts, and saves nothing
  - `existing` and `repeated` detected; same phone with a different name imports both
  - save creates the batch with its counts, inserts customers with `source = 'import'` and
    `import_id`, saves addresses with equipment and notes, and writes no consent rows
  - 5,000-row limit; nothing ready gives 422
  - importing the same file twice creates nothing the second time
  - undo removes the batch except a customer with a job, returns `{ removed, kept }`, then 409
  - another contractor's import gives 404; a technician gets 403
  - online booking's returning-customer tests still pass after the same-customer change

### Web (pure functions)

- `guess-columns.test.ts`: aliases, punctuation and case, mobile preferred, first + last name,
  one-column address picked when only "Address" is recognised, each column used once.
- `to-rows.test.ts`: heading row found, blank rows skipped, numbers turned into text (Excel
  date cells become `YYYY-MM-DD`), row numbers kept, only matched fields sent.
- `problem-rows.test.ts`: quoting of commas and quotes, the added "Problem" column.

### By hand (headless Edge)

Import a sample `.xlsx` with unusual headings and a sample `.csv`; fix a wrong column guess;
check the counts and download the rows to fix; import and see the customers in the list (and an
imported customer's record says "imported"); undo, including a customer kept because of a job;
the same at phone width.

## Branching

Part 1 (`feat/customers-screen`) isn't merged yet. This work goes on `feat/customer-import`,
started from `feat/customers-screen` in both repos, so it can begin before those pull requests
land.
