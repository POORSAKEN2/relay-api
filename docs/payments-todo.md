# Payments: to build later

The technician's job page (`relay-web/src/features/technician-jobs/`) ships a "To be paid by
homeowner" screen, `payment-sheet.tsx`, that opens when the technician taps **Job complete**.
No card money moves yet. A cash or check payment is recorded: **Job done** sends
`paidInPerson`, and `recordPaymentInPerson()` (`src/modules/charges/charges.service.ts`)
issues the job's invoice already paid, then the homeowner gets the receipt by text and email
(`src/modules/homeowner-messages/`). This file lists what is a stand-in today and what to
build when card payments arrive (MVP module 9).

## Stand-ins today

| Where | Today | When payments exist |
|---|---|---|
| `payment-sheet.tsx`, QR box | Dashed box: "Card payment by QR is coming soon" | The QR code of the invoice's payment link |
| `payment-sheet.tsx`, "Homeowner paid in person (cash or check)" | Ticking it turns **Job done** on; the server records the payment (invoice paid, no `payments` row) and sends the receipt | Kept for cash and check. A card payment turns Job done on by itself. |
| `payment-sheet.tsx`, nothing due ($0) | No checkbox, Job done is on, no invoice | Same; no invoice needs paying |
| `job-done.tsx` | "Job done!" | "All Paid!" once the payment is confirmed |
| API `POST /api/my-jobs/:jobId/complete` | Refuses a visit with something to pay unless `paidInPerson` | Also accepts a card payment |
| Office drawer "Mark done" | No payment check, no invoice, no receipt | Same rule as the technician |

The rule "a job isn't done until the homeowner paid" lives in the technician's Job complete
(`completeJob()` in `technician-jobs.service.ts`). The office's "Mark done" doesn't know
about it yet.

## Decision to record first

- [ ] The job repairs spec (`docs/superpowers/specs/2026-10-02-job-repairs-design.md`, step 2)
      says "Done doesn't wait for payment". The product decision now (2026-10-03) is that a job
      is **not done until the homeowner paid**. Update that spec, and decide what the office
      can do with an unpaid job (for example, mark done as "unpaid", or never).

## Must have

- [ ] **Provider and keys.** Xendit or Stripe per contractor: `tenants.payment_provider` and
      `tenants.payment_account_id` already exist. Add the keys to `.env` and
      `src/config/env.ts`.
- [ ] **Invoice before payment.** For card payments the invoice must exist before it is paid
      (the payment link points at it): issue it, unpaid, when the technician opens the payment
      screen. Today it is only issued, already paid, at Job complete
      (`insertPaidInvoice()` in `charges.queries.ts` shows the numbering). Move the
      "can't be done without a paid invoice" rule into `changeStatus()`
      (`src/modules/dispatch/dispatch.service.ts`), so the office's "Mark done" follows it too.
- [ ] **Payment link and QR.** Create a `payment_links` row (purpose `pay_invoice`) with the
      provider's hosted page. Show its `url` as a QR code in the dashed box. A small QR library
      (or the provider's own QR image) is needed. Show the link as text too, for homeowners who
      can't scan.
- [ ] **Webhook.** On the provider's "payment succeeded":
  - Check the signature.
  - Store the raw event in `webhook_events` and skip duplicates by event id.
  - Write a `payments` row (`succeeded`) and set `invoices.status = 'paid'` and `paid_at`.
  - Emit a live event (for example `job.paid`), so the technician's screen turns **Job done**
    on and shows "All Paid!" without a refresh. Add it to `useMyJobsLiveUpdates()` in
    `relay-web/src/features/technician-jobs/api.ts`.
- [x] **Cash and check on the server** (2026-10-05). Job complete sends `paidInPerson`; the
      invoice is marked paid without a `payments` row (`invoices_paid_at_matches` allows it),
      and an `invoice.paid` audit event records who took it. Cash and check aren't told apart.
- [ ] **Show the payment in the office drawer** (invoice number, total, paid).
- [x] **Receipt** (2026-10-05) by text and email, through the messages outbox.
- [ ] **Homeowner's email on the payment screen.** `customers.email` is often empty, so let
      the technician type it before Job done, to save on the customer and receive the receipt.
- [ ] **Job page data.** Add the invoice (number, total, status, payment link url) to
      `GET /api/my-jobs/:jobId`, and to the `MyJob` schema in
      `relay-web/src/features/technician-jobs/api.ts`.
- [ ] **Repairs waiting.** The API still lets a job be completed while repairs wait for the
      homeowner's answer; only the technician's bottom button prevents it. Add that check to
      `changeStatus()` too.

## Later

- [ ] Card on file and deposits at booking (`payment_methods`, `payment_links` purposes
      `save_card` and `pay_deposit`).
- [ ] Payment reminder texts for unpaid invoices (message purpose `payment_reminder`; needs
      real texting, see `docs/real-texting-todo.md`).
- [ ] Refunds (`payments.status = 'refunded'`).
