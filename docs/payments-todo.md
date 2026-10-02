# Payments: to build later

The technician's job page (`relay-web/src/features/technician-jobs/`) ships a "To be paid by
homeowner" screen, `payment-sheet.tsx`, that opens when the technician taps **Job complete**.
No money moves yet and nothing about payment is saved. This file lists what is a stand-in
today and what to build when payments arrive (MVP module 9).

## Stand-ins today

| Where | Today | When payments exist |
|---|---|---|
| `payment-sheet.tsx`, QR box | Dashed box: "Card payment by QR is coming soon" | The QR code of the invoice's payment link |
| `payment-sheet.tsx`, **Email receipt (coming soon)** | Disabled button | Emails the invoice / receipt to the homeowner |
| `payment-sheet.tsx`, "Homeowner paid in person (cash or check)" | A checkbox on the screen only. Ticking it turns **Job done** on. Not saved. | Kept for cash and check, but recorded on the server. A card payment turns Job done on by itself. |
| `payment-sheet.tsx`, nothing due ($0) | No checkbox, Job done is on | Same; no invoice needs paying |
| `job-done.tsx` | "Job done!" | "All Paid!" once the payment is confirmed |
| API `POST /api/my-jobs/:jobId/complete` | Marks the job done with no payment check | Refuses until the invoice is paid (see below) |
| Office drawer "Mark done" | No payment check | Same rule as the technician |

The rule "a job isn't done until the homeowner paid" lives **only in the technician's
screen** today. The API and the office don't know about it.

## Decision to record first

- [ ] The job repairs spec (`docs/superpowers/specs/2026-10-02-job-repairs-design.md`, step 2)
      says "Done doesn't wait for payment". The product decision now (2026-10-03) is that a job
      is **not done until the homeowner paid**. Update that spec, and decide what the office
      can do with an unpaid job (for example, mark done as "unpaid", or never).

## Must have

- [ ] **Provider and keys.** Xendit or Stripe per contractor: `tenants.payment_provider` and
      `tenants.payment_account_id` already exist. Add the keys to `.env` and
      `src/config/env.ts`.
- [ ] **Invoice.** Build "Finish & invoice" (step 2 of the job repairs spec): issue the invoice
      from the approved lines when the technician opens the payment screen, or when they tap Job
      complete. Use the `invoices` table: one per job, `number` per contractor, `total_cents` =
      approved total. Put the "can't be done without a paid invoice" rule in
      `changeStatus()` (`src/modules/dispatch/dispatch.service.ts`), so the office's
      "Mark done" follows it too.
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
- [ ] **Cash and check on the server.** Replace the checkbox's local state with an API call
      that records the in-person payment, and show it in the office drawer. The `payments`
      table needs `provider`, `provider_payment_id` and `amount_cents > 0`, which don't fit
      cash. Either add a method (`cash`, `check`) to it, or mark the invoice paid without a
      `payments` row (`invoices_paid_at_matches` allows that). Decide which before building.
- [ ] **Email receipt.** Needs a real email sender (the `messages` table already has channel
      `email` and purpose `invoice`). `customers.email` is often empty, so let the technician
      type the homeowner's email on the payment screen.
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
