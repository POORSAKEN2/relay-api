-- Relay MVP schema: draft for ERD review (all 13 modules).
--
-- Built in a scratch schema so it never collides with Drizzle migrations in public.
-- Re-running drops and rebuilds ONLY the erd_draft schema.
--
-- Conventions:
--   * id uuid primary key default gen_random_uuid()
--   * tenant tables: tenant_id not null; parents get unique (tenant_id, id);
--     children reference them by (tenant_id, x_id), so the DB blocks cross-tenant links
--   * fixed value sets: text + check constraint (no Postgres enums)
--   * money: integer cents in the contractor's currency
--   * phones: E.164 ('+14805551234'); emails stored lowercase
--   * FKs block deletes (no action); cascade only for sessions and sign-in codes
--   * nothing PostgreSQL 18-only

drop schema if exists erd_draft cascade;
create schema erd_draft;
set search_path to erd_draft;


-- =====================================================================
-- 1 · White-label setup   13 · Ownership and accounts
-- =====================================================================

create table tenants (
  id                        uuid primary key default gen_random_uuid(),
  slug                      text not null unique,             -- desert → desert.garified.com
  name                      text not null,
  status                    text not null default 'setup',
  timezone                  text not null,                    -- IANA, e.g. 'America/Phoenix'; validated in app
  currency                  text not null default 'USD',
  contact_email             text not null,
  contact_phone             text not null,
  custom_domain             text unique,                      -- book.desertbreezeair.com
  custom_domain_verified_at timestamptz,
  -- phone line
  office_phone              text,                             -- rung first; AI answers if no pickup
  office_ring_seconds       smallint not null default 15,
  on_call_phone             text,                             -- transfers and gas/CO calls
  -- texting registration (10DLC)
  texting_status            text not null default 'not_registered',
  messaging_service_sid     text,                             -- Twilio Messaging Service for the campaign
  -- booking and messaging rules
  hold_minutes              smallint not null default 15,     -- still to decide
  quiet_hours_start         time not null default '21:00',    -- still to decide
  quiet_hours_end           time not null default '08:00',
  review_url                text,                             -- link in the review-request text
  -- contractor payouts
  payment_provider          text,
  payment_account_id        text,                             -- Xendit sub-account / Stripe Connect account
  -- Relay billing
  monthly_fee_cents         integer not null default 0,
  per_job_fee_cents         integer not null default 0,       -- per recovered job
  created_at                timestamptz not null default now(),
  constraint tenants_slug_format
    check (slug ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'),
  constraint tenants_slug_not_reserved
    check (slug not in ('admin', 'api', 'www')),
  constraint tenants_status_valid
    check (status in ('setup', 'live', 'suspended')),
  constraint tenants_currency_format
    check (currency ~ '^[A-Z]{3}$'),
  constraint tenants_custom_domain_lowercase
    check (custom_domain = lower(custom_domain)),
  constraint tenants_contact_phone_e164
    check (contact_phone ~ '^\+[1-9][0-9]{7,14}$'),
  constraint tenants_office_phone_e164
    check (office_phone ~ '^\+[1-9][0-9]{7,14}$'),
  constraint tenants_on_call_phone_e164
    check (on_call_phone ~ '^\+[1-9][0-9]{7,14}$'),
  constraint tenants_office_ring_seconds_positive
    check (office_ring_seconds > 0),
  constraint tenants_texting_status_valid
    check (texting_status in ('not_registered', 'pending', 'approved', 'rejected')),
  constraint tenants_hold_minutes_positive
    check (hold_minutes > 0),
  constraint tenants_quiet_hours_window
    check (quiet_hours_start <> quiet_hours_end),
  constraint tenants_payment_provider_valid
    check (payment_provider in ('xendit', 'stripe')),
  constraint tenants_fees_not_negative
    check (monthly_fee_cents >= 0 and per_job_fee_cents >= 0)
);

create table users (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid references tenants (id),        -- null only for superadmin
  role          text not null,
  name          text not null,
  email         text unique,                         -- office sign-in; technicians may have none
  phone         text unique,                         -- technician SMS sign-in and alerts
  password_hash text,                                -- scrypt params + salt + hash
  disabled_at   timestamptz,                         -- deactivated users keep their history
  created_at    timestamptz not null default now(),
  unique (tenant_id, id),
  constraint users_role_valid
    check (role in ('owner', 'office', 'technician', 'superadmin')),
  constraint users_tenant_matches_role
    check ((role = 'superadmin') = (tenant_id is null)),
  constraint users_email_lowercase
    check (email = lower(email)),
  constraint users_phone_e164
    check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  constraint users_sign_in_method
    check ((role = 'technician' and phone is not null)
        or (role <> 'technician' and email is not null))
);

create table sessions (
  id         text primary key,                       -- hex sha256 of the cookie token
  user_id    uuid not null references users (id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint sessions_id_format
    check (id ~ '^[0-9a-f]{64}$')
);

create index sessions_user_id_idx on sessions (user_id);

create table sign_in_codes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users (id) on delete cascade,
  code_hash  text not null,                          -- HMAC-SHA256 of the 6-digit code with a server secret
  attempts   smallint not null default 0,
  expires_at timestamptz not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);

create index sign_in_codes_user_id_idx on sign_in_codes (user_id);

create table branding_versions (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants (id),
  primary_color text not null,
  accent_color  text not null,
  logo_url      text,
  favicon_url   text,
  created_by    uuid not null references users (id),  -- plain FK: author is a superadmin (no tenant)
  created_at    timestamptz not null default now(),
  constraint branding_versions_primary_color_format
    check (primary_color ~ '^#[0-9a-f]{6}$'),
  constraint branding_versions_accent_color_format
    check (accent_color ~ '^#[0-9a-f]{6}$')
);

-- current branding = newest row per tenant (order by created_at desc, id desc)
create index branding_versions_tenant_newest_idx
  on branding_versions (tenant_id, created_at desc);

create table phone_numbers (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants (id),
  number       text not null,                        -- Twilio webhooks find the tenant by this
  provider_sid text unique,                          -- Twilio IncomingPhoneNumber SID
  status       text not null default 'active',
  created_at   timestamptz not null default now(),
  constraint phone_numbers_number_e164
    check (number ~ '^\+[1-9][0-9]{7,14}$'),
  constraint phone_numbers_status_valid
    check (status in ('porting', 'active', 'released'))
);

-- a number belongs to one contractor at a time
create unique index phone_numbers_number_in_use_key
  on phone_numbers (number) where status <> 'released';

create table subscription_invoices (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants (id),
  period_start        date not null,
  period_end          date not null,
  monthly_fee_cents   integer not null,
  recovered_jobs      integer not null,              -- metered count, frozen when the invoice is made
  per_job_fee_cents   integer not null,
  total_cents         integer not null,
  status              text not null default 'open',
  provider_invoice_id text,
  paid_at             timestamptz,
  created_at          timestamptz not null default now(),
  unique (tenant_id, period_start),
  constraint subscription_invoices_period_order
    check (period_end > period_start),
  constraint subscription_invoices_status_valid
    check (status in ('open', 'paid', 'void')),
  constraint subscription_invoices_total_matches
    check (total_cents = monthly_fee_cents + recovered_jobs * per_job_fee_cents),
  constraint subscription_invoices_paid_at_matches
    check ((status = 'paid') = (paid_at is not null))
);


-- =====================================================================
-- 2 · Online booking   6 · Scheduling and dispatch (setup tables)
-- =====================================================================

create table services (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants (id),
  name        text not null,                         -- 'AC repair', 'Tune-up', 'New-system estimate'
  description text,
  price_type  text not null,                         -- fixed price, or a diagnostic fee with the repair priced on site
  price_cents integer not null,
  sort_order  smallint not null default 0,
  archived_at timestamptz,                           -- hidden from booking; old jobs still point here
  created_at  timestamptz not null default now(),
  unique (tenant_id, id),
  constraint services_price_type_valid
    check (price_type in ('fixed', 'diagnostic', 'free')),
  constraint services_price_matches_type
    check ((price_type = 'free') = (price_cents = 0)),
  constraint services_price_not_negative
    check (price_cents >= 0)
);

create table price_items (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants (id),
  name        text not null,                         -- 'Capacitor replacement'
  price_cents integer not null,
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  unique (tenant_id, id),
  constraint price_items_price_not_negative
    check (price_cents >= 0)
);

create table service_area_zips (
  tenant_id uuid not null references tenants (id),
  zip       text not null,
  primary key (tenant_id, zip),
  constraint service_area_zips_zip_format
    check (zip ~ '^[0-9]{5}$')
);

-- office hours: outside them the AI answers right away. No row for a weekday = closed.
create table business_hours (
  tenant_id uuid not null references tenants (id),
  weekday   smallint not null,                       -- 0 = Sunday … 6 = Saturday
  opens_at  time not null,                           -- tenant local time
  closes_at time not null,
  primary key (tenant_id, weekday),
  constraint business_hours_weekday_range
    check (weekday between 0 and 6),
  constraint business_hours_order
    check (closes_at > opens_at)
);

-- bookable arrival windows. To book, the service locks the window row
-- (select … for update), counts active jobs in that window on that date,
-- then inserts the hold, so web and AI can never both take the last slot.
create table arrival_windows (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id),
  weekday   smallint not null,
  starts_at time not null,                           -- tenant local time
  ends_at   time not null,
  job_cap   smallint not null,                       -- jobs per window
  unique (tenant_id, weekday, starts_at),
  constraint arrival_windows_weekday_range
    check (weekday between 0 and 6),
  constraint arrival_windows_order
    check (ends_at > starts_at),
  constraint arrival_windows_job_cap_positive
    check (job_cap > 0)
);


-- =====================================================================
-- 7 · Customers
-- =====================================================================

create table customers (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants (id),
  name       text not null,
  phone      text,                                   -- matched against callers and texts
  email      text,
  notes      text,
  source     text not null,                          -- how the record was first created
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  constraint customers_phone_e164
    check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  constraint customers_email_lowercase
    check (email = lower(email)),
  constraint customers_source_valid
    check (source in ('booking', 'call', 'office', 'import'))
);

-- not unique: spreadsheet imports and shared household phones can repeat
create index customers_tenant_phone_idx on customers (tenant_id, phone);

-- service address, with the simple equipment field
create table properties (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants (id),
  customer_id     uuid not null,
  street          text not null,
  unit            text,
  city            text not null,
  state           text not null,
  zip             text not null,
  equipment_brand text,
  equipment_year  smallint,                          -- approximate install year; age = now − year
  notes           text,                              -- gate code, dog, attic access
  created_at      timestamptz not null default now(),
  unique (tenant_id, customer_id, id),
  foreign key (tenant_id, customer_id) references customers (tenant_id, id),
  constraint properties_state_format
    check (state ~ '^[A-Z]{2}$'),
  constraint properties_zip_format
    check (zip ~ '^[0-9]{5}$'),
  constraint properties_equipment_year_range
    check (equipment_year between 1950 and 2100)
);


-- =====================================================================
-- 3 · Missed-call text-back   4 · AI receptionist
-- =====================================================================

create table calls (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants (id),
  customer_id    uuid,                               -- matched by caller number, if known
  provider_sid   text not null unique,               -- Twilio CallSid
  from_phone     text,                               -- null = caller ID blocked
  to_phone       text not null,                      -- the contractor number that was called
  answered_by    text,                               -- null = hung up while it rang (missed)
  transferred_at timestamptz,                        -- AI handed the call to staff or on-call
  safety_flag    boolean not null default false,     -- gas or CO: safety script, never booked
  priority       boolean not null default false,     -- vulnerable person with no heat or cooling
  disclosed_at   timestamptz,                        -- "this is an AI and the call is recorded"
  recording_key  text,                               -- private file-storage key
  transcript     text,
  summary        text,                               -- AI summary, also added to the job notes
  started_at     timestamptz not null default now(),
  ended_at       timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, customer_id) references customers (tenant_id, id),
  constraint calls_answered_by_valid
    check (answered_by in ('office', 'ai')),
  constraint calls_ai_disclosed
    check (answered_by <> 'ai' or disclosed_at is not null),
  constraint calls_from_phone_e164
    check (from_phone ~ '^\+[1-9][0-9]{7,14}$'),
  constraint calls_to_phone_e164
    check (to_phone ~ '^\+[1-9][0-9]{7,14}$')
);

create index calls_tenant_started_idx on calls (tenant_id, started_at desc);


-- =====================================================================
-- 2 · Online booking   6 · Dispatch   8 · Technician job page
-- One row per visit: held → booked → en_route → in_progress → done
-- =====================================================================

create table jobs (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants (id),
  customer_id         uuid not null,
  property_id         uuid not null,
  service_id          uuid not null,
  technician_id       uuid,                          -- null until the office assigns one
  call_id             uuid,                          -- the call it came from (AI, office or text-back)
  status              text not null default 'held',
  source              text not null,                 -- feeds the recovered-revenue dashboard and per-job fee
  priority            boolean not null default false,
  -- intake
  problem             text not null,
  system_type         text not null,
  vulnerable_occupant boolean not null default false,
  -- schedule
  window_starts_at    timestamptz not null,
  window_ends_at      timestamptz not null,
  eta_at              timestamptz,                   -- set by 'On my way' / 'Running late'
  hold_expires_at     timestamptz,
  -- links (sha256 of random tokens; cleared when the job closes)
  tech_link_hash      text unique,                   -- technician job page
  manage_link_hash    text unique,                   -- homeowner reschedule / cancel
  created_by          uuid,                          -- office user; null = homeowner or AI
  booked_at           timestamptz,
  completed_at        timestamptz,
  created_at          timestamptz not null default now(),
  unique (tenant_id, id),
  -- one FK checks tenant AND that the property belongs to this customer
  foreign key (tenant_id, customer_id, property_id)
    references properties (tenant_id, customer_id, id),
  foreign key (tenant_id, service_id) references services (tenant_id, id),
  foreign key (tenant_id, technician_id) references users (tenant_id, id),
  foreign key (tenant_id, call_id) references calls (tenant_id, id),
  foreign key (tenant_id, created_by) references users (tenant_id, id),
  constraint jobs_status_valid
    check (status in ('held', 'expired', 'booked', 'en_route', 'in_progress',
                      'no_access', 'done', 'cancelled')),
  constraint jobs_source_valid
    check (source in ('web', 'text_back', 'ai', 'recovery_text', 'office')),
  constraint jobs_system_type_valid
    check (system_type in ('central_ac', 'heat_pump', 'furnace', 'boiler',
                           'mini_split', 'other', 'not_sure')),
  constraint jobs_window_order
    check (window_ends_at > window_starts_at),
  constraint jobs_hold_has_expiry
    check (status <> 'held' or hold_expires_at is not null),
  constraint jobs_visit_has_technician
    check (status not in ('en_route', 'in_progress', 'done') or technician_id is not null),
  constraint jobs_closed_links_cleared
    check (status not in ('done', 'cancelled', 'expired')
           or (tech_link_hash is null and manage_link_hash is null))
);

create index jobs_tenant_window_idx on jobs (tenant_id, window_starts_at);
create index jobs_tenant_technician_window_idx on jobs (tenant_id, technician_id, window_starts_at);
create index jobs_tenant_customer_idx on jobs (tenant_id, customer_id);

-- the booked service line plus repairs added from the price list
create table job_items (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants (id),
  job_id           uuid not null,
  price_item_id    uuid,                             -- null for the booked service line
  description      text not null,                    -- copied at the time, so later price changes don't rewrite history
  quantity         smallint not null default 1,
  unit_price_cents integer not null,
  status           text not null default 'proposed', -- homeowner approves or declines on site
  created_by       uuid,
  created_at       timestamptz not null default now(),
  foreign key (tenant_id, job_id) references jobs (tenant_id, id),
  foreign key (tenant_id, price_item_id) references price_items (tenant_id, id),
  foreign key (tenant_id, created_by) references users (tenant_id, id),
  constraint job_items_status_valid
    check (status in ('proposed', 'approved', 'declined')),
  constraint job_items_quantity_positive
    check (quantity > 0),
  constraint job_items_price_not_negative
    check (unit_price_cents >= 0)
);

create index job_items_job_idx on job_items (tenant_id, job_id);

create table job_notes (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants (id),
  job_id     uuid not null,
  author_id  uuid,                                   -- null = AI call summary
  body       text not null,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, job_id) references jobs (tenant_id, id),
  foreign key (tenant_id, author_id) references users (tenant_id, id)
);

create index job_notes_job_idx on job_notes (tenant_id, job_id);

create table job_photos (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants (id),
  job_id      uuid not null,
  storage_key text not null,                         -- private file-storage key, served by signed URL
  stage       text not null,
  uploaded_by uuid not null,
  created_at  timestamptz not null default now(),
  foreign key (tenant_id, job_id) references jobs (tenant_id, id),
  foreign key (tenant_id, uploaded_by) references users (tenant_id, id),
  constraint job_photos_stage_valid
    check (stage in ('before', 'after'))
);

create index job_photos_job_idx on job_photos (tenant_id, job_id);

create table waitlist_entries (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants (id),
  customer_id uuid not null,
  service_id  uuid not null,
  zip         text not null,
  priority    boolean not null default false,        -- lets "first-come or priority-first" go either way
  status      text not null default 'waiting',
  offered_at  timestamptz,
  created_at  timestamptz not null default now(),
  foreign key (tenant_id, customer_id) references customers (tenant_id, id),
  foreign key (tenant_id, service_id) references services (tenant_id, id),
  constraint waitlist_entries_status_valid
    check (status in ('waiting', 'offered', 'booked', 'removed')),
  constraint waitlist_entries_zip_format
    check (zip ~ '^[0-9]{5}$')
);

create index waitlist_entries_waiting_idx
  on waitlist_entries (tenant_id, created_at) where status = 'waiting';

-- AI take_message, and the web "outside our area" form
create table callback_requests (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants (id),
  call_id     uuid,
  name        text,
  phone       text not null,
  zip         text,
  message     text not null,
  source      text not null,
  resolved_at timestamptz,
  resolved_by uuid,
  created_at  timestamptz not null default now(),
  foreign key (tenant_id, call_id) references calls (tenant_id, id),
  foreign key (tenant_id, resolved_by) references users (tenant_id, id),
  constraint callback_requests_source_valid
    check (source in ('ai', 'web')),
  constraint callback_requests_ai_has_call
    check (source <> 'ai' or call_id is not null),
  constraint callback_requests_phone_e164
    check (phone ~ '^\+[1-9][0-9]{7,14}$')
);

create index callback_requests_open_idx
  on callback_requests (tenant_id, created_at) where resolved_at is null;


-- =====================================================================
-- 3 · Two-way text inbox   10 · Notifications
-- Every SMS and email, both directions. Outbound rows are written by the
-- compliance gate; sign-in code bodies are stored masked.
-- =====================================================================

create table messages (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants (id),
  channel             text not null,
  direction           text not null,
  contact             text not null,                 -- the other side: phone (E.164) or email
  kind                text not null,
  subject             text,                          -- email only
  body                text not null,
  status              text not null,
  blocked_reason      text,                          -- why the gate stopped it
  provider_message_id text unique,                   -- Twilio MessageSid / email Message-ID
  customer_id         uuid,
  job_id              uuid,
  call_id             uuid,                          -- the call a text-back answers
  to_user_id          uuid,                          -- staff or technician alerts
  sent_by_user_id     uuid,                          -- office reply typed in the inbox
  read_at             timestamptz,                   -- inbound only: inbox unread state
  created_at          timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, customer_id) references customers (tenant_id, id),
  foreign key (tenant_id, job_id) references jobs (tenant_id, id),
  foreign key (tenant_id, call_id) references calls (tenant_id, id),
  foreign key (tenant_id, to_user_id) references users (tenant_id, id),
  foreign key (tenant_id, sent_by_user_id) references users (tenant_id, id),
  constraint messages_channel_valid
    check (channel in ('sms', 'email')),
  constraint messages_direction_valid
    check (direction in ('inbound', 'outbound')),
  constraint messages_status_valid
    check (status in ('queued', 'sent', 'delivered', 'failed', 'blocked', 'received')),
  constraint messages_inbound_is_received
    check ((direction = 'inbound') = (status = 'received')),
  constraint messages_blocked_has_reason
    check ((status = 'blocked') = (blocked_reason is not null)),
  constraint messages_blocked_reason_valid
    check (blocked_reason in ('no_consent', 'opted_out')),
  constraint messages_kind_valid
    check (kind in (
      'inbound', 'manual',
      'text_back', 'missed_caller_reminder', 'abandoned_booking', 'waitlist_offer',
      'booking_confirmation', 'booking_changed', 'reminder', 'card_link',
      'on_my_way', 'running_late', 'job_started', 'no_access',
      'invoice', 'payment_reminder', 'review_request',
      'job_assigned', 'new_booking_alert', 'priority_alert',
      'sign_in_code'
    ))
);

create index messages_thread_idx on messages (tenant_id, contact, created_at desc);
create index messages_job_idx on messages (tenant_id, job_id);


-- =====================================================================
-- 9 · Payments (tokens only; card numbers never reach Relay)
-- =====================================================================

create table payment_methods (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants (id),
  customer_id        uuid not null,
  provider           text not null,
  provider_method_id text not null,                  -- provider token
  brand              text,                           -- 'visa'
  last4              text,
  exp_month          smallint,
  exp_year           smallint,
  removed_at         timestamptz,
  created_at         timestamptz not null default now(),
  unique (tenant_id, id),
  unique (provider, provider_method_id),
  foreign key (tenant_id, customer_id) references customers (tenant_id, id),
  constraint payment_methods_provider_valid
    check (provider in ('xendit', 'stripe')),
  constraint payment_methods_last4_format
    check (last4 ~ '^[0-9]{4}$'),
  constraint payment_methods_exp_month_range
    check (exp_month between 1 and 12)
);

create index payment_methods_customer_idx on payment_methods (tenant_id, customer_id);

create table invoices (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants (id),
  job_id      uuid not null,
  number      integer not null,                      -- per contractor: 1, 2, 3 …
  total_cents integer not null,                      -- approved job items when it was issued
  status      text not null default 'open',
  paid_at     timestamptz,
  created_at  timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, job_id),                        -- one invoice per job
  unique (tenant_id, number),
  foreign key (tenant_id, job_id) references jobs (tenant_id, id),
  constraint invoices_status_valid
    check (status in ('open', 'paid', 'void')),
  constraint invoices_paid_at_matches
    check ((status = 'paid') = (paid_at is not null)),
  constraint invoices_total_not_negative
    check (total_cents >= 0)
);

-- provider-hosted pages sent by text: save a card, pay the diagnostic fee, pay an invoice
create table payment_links (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants (id),
  job_id           uuid not null,
  invoice_id       uuid,
  purpose          text not null,
  provider         text not null,
  provider_link_id text not null,                    -- webhooks find the job by this
  url              text not null,
  status           text not null default 'open',
  expires_at       timestamptz,
  completed_at     timestamptz,
  created_at       timestamptz not null default now(),
  unique (provider, provider_link_id),
  foreign key (tenant_id, job_id) references jobs (tenant_id, id),
  foreign key (tenant_id, invoice_id) references invoices (tenant_id, id),
  constraint payment_links_purpose_valid
    check (purpose in ('save_card', 'pay_deposit', 'pay_invoice')),
  constraint payment_links_invoice_matches_purpose
    check ((purpose = 'pay_invoice') = (invoice_id is not null)),
  constraint payment_links_provider_valid
    check (provider in ('xendit', 'stripe')),
  constraint payment_links_status_valid
    check (status in ('open', 'completed', 'expired'))
);

create table payments (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants (id),
  job_id              uuid not null,
  invoice_id          uuid,                          -- null for a deposit taken at booking
  payment_method_id   uuid,                          -- null when paid through a link
  amount_cents        integer not null,
  status              text not null,
  provider            text not null,
  provider_payment_id text not null,
  failure_reason      text,
  succeeded_at        timestamptz,
  created_at          timestamptz not null default now(),
  unique (provider, provider_payment_id),
  foreign key (tenant_id, job_id) references jobs (tenant_id, id),
  foreign key (tenant_id, invoice_id) references invoices (tenant_id, id),
  foreign key (tenant_id, payment_method_id) references payment_methods (tenant_id, id),
  constraint payments_amount_positive
    check (amount_cents > 0),
  constraint payments_status_valid
    check (status in ('pending', 'succeeded', 'failed', 'refunded')),
  constraint payments_provider_valid
    check (provider in ('xendit', 'stripe'))
);

create index payments_job_idx on payments (tenant_id, job_id);


-- =====================================================================
-- 12 · Compliance
-- =====================================================================

-- append-only consent log. Current consent = newest row per (tenant, contact, channel).
-- A STOP reply writes granted = false for sms.
create table consent_events (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants (id),
  contact    text not null,                          -- phone (E.164) or email
  channel    text not null,
  granted    boolean not null,
  source     text not null,
  wording    text,                                   -- exact text shown or spoken, as proof
  job_id     uuid,
  call_id    uuid,
  message_id uuid,                                   -- the STOP / START reply
  ip         inet,                                   -- web form submissions
  created_by uuid,                                   -- office user, when entered by hand
  created_at timestamptz not null default now(),
  foreign key (tenant_id, job_id) references jobs (tenant_id, id),
  foreign key (tenant_id, call_id) references calls (tenant_id, id),
  foreign key (tenant_id, message_id) references messages (tenant_id, id),
  foreign key (tenant_id, created_by) references users (tenant_id, id),
  constraint consent_events_channel_valid
    check (channel in ('sms', 'voice', 'email')),
  constraint consent_events_source_valid
    check (source in ('booking_form', 'call', 'sms_reply', 'office', 'import')),
  constraint consent_events_reply_has_message
    check ((source = 'sms_reply') = (message_id is not null))
);

create index consent_events_lookup_idx
  on consent_events (tenant_id, contact, channel, created_at desc);

-- append-only audit log: consent, messages, payments, branding, job status changes
create table audit_events (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid references tenants (id),        -- null for platform actions by superadmin
  actor_type    text not null,
  actor_user_id uuid references users (id),          -- plain FK: actor may be a superadmin
  action        text not null,                       -- 'job.assigned', 'message.sent', 'branding.updated'
  entity_type   text not null,                       -- 'job', 'message', 'payment', 'tenant'
  entity_id     uuid,
  data          jsonb not null default '{}',
  created_at    timestamptz not null default now(),
  constraint audit_events_actor_type_valid
    check (actor_type in ('user', 'homeowner', 'ai', 'system')),
  constraint audit_events_actor_user_matches
    check ((actor_type = 'user') = (actor_user_id is not null))
);

create index audit_events_entity_idx
  on audit_events (tenant_id, entity_type, entity_id, created_at);

-- block update and delete (TRUNCATE still works, so tests can reset)
create function audit_events_append_only() returns trigger
language plpgsql as $$
begin
  raise exception 'audit_events is append-only';
end;
$$;

create trigger audit_events_append_only
  before update or delete on audit_events
  for each row execute function audit_events_append_only();

-- webhook dedupe: insert first; a conflict means this event was already handled
create table webhook_events (
  provider    text not null,
  event_id    text not null,                         -- Twilio SID / Xendit event id
  received_at timestamptz not null default now(),
  primary key (provider, event_id),
  constraint webhook_events_provider_valid
    check (provider in ('twilio', 'xendit', 'stripe'))
);
