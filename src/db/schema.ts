import { type Column, sql } from 'drizzle-orm'
import {
  boolean,
  check,
  customType,
  date,
  foreignKey,
  index,
  inet,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  time,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

// Conventions (design and ERD: docs/superpowers/specs/2026-09-29-mvp-schema-draft.sql):
// - Tenant tables have `tenant_id not null`. Parents get unique (tenant_id, id) and children
//   reference them by (tenant_id, x_id), so the database blocks links across contractors.
// - Fixed value sets are text + a check constraint (no Postgres enums). Each set is one
//   exported list that types the column and builds its check with `oneOf()`.
// - Money is integer cents in the contractor's currency.
// - Phones are E.164 ('+14805551234'); emails are stored lowercase.
// - Foreign keys block deletes; only sessions and sign-in codes cascade.

const timestamptz = (name: string) => timestamp(name, { withTimezone: true })
const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' })
const createdAt = () => timestamptz('created_at').notNull().defaultNow()
const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.id)

// Check: the column holds one of the values (null passes, like any check).
function oneOf(column: Column, values: readonly string[]) {
  return sql`${column} in (${sql.raw(values.map((value) => `'${value}'`).join(', '))})`
}

// Check: the column is an E.164 phone number.
function e164(column: Column) {
  return sql`${column} ~ '^\\+[1-9][0-9]{7,14}$'`
}

export const PAYMENT_PROVIDERS = ['xendit', 'stripe'] as const

// =====================================================================
// 1 · White-label setup   13 · Ownership and accounts
// =====================================================================

export const TENANT_STATUSES = ['setup', 'live', 'suspended'] as const
export const TEXTING_STATUSES = ['not_registered', 'pending', 'approved', 'rejected'] as const

export const tenants = pgTable(
  'tenants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull().unique(), // desert → desert.garified.com
    name: text('name').notNull(),
    status: text('status', { enum: TENANT_STATUSES }).notNull().default('setup'),
    timezone: text('timezone').notNull(), // IANA, e.g. 'America/Phoenix'; validated in the app
    currency: text('currency').notNull().default('USD'),
    contactEmail: text('contact_email').notNull(),
    contactPhone: text('contact_phone').notNull(),
    customDomain: text('custom_domain').unique(), // book.desertbreezeair.com
    customDomainVerifiedAt: timestamptz('custom_domain_verified_at'),
    // Phone line
    officePhone: text('office_phone'), // rung first; the AI answers if nobody picks up
    officeRingSeconds: smallint('office_ring_seconds').notNull().default(15),
    onCallPhone: text('on_call_phone'), // transfers and gas/CO calls
    // Texting registration (10DLC)
    textingStatus: text('texting_status', { enum: TEXTING_STATUSES })
      .notNull()
      .default('not_registered'),
    messagingServiceSid: text('messaging_service_sid'), // Twilio Messaging Service for the campaign
    // Booking and messaging rules
    holdMinutes: smallint('hold_minutes').notNull().default(15), // still to decide
    // Extra charge a homeowner can pay online to be seen first. 0 = not offered.
    priorityFeeCents: integer('priority_fee_cents').notNull().default(0),
    quietHoursStart: time('quiet_hours_start').notNull().default('21:00'), // still to decide
    quietHoursEnd: time('quiet_hours_end').notNull().default('08:00'),
    reviewUrl: text('review_url'), // link in the review-request text
    // Contractor payouts
    paymentProvider: text('payment_provider', { enum: PAYMENT_PROVIDERS }),
    paymentAccountId: text('payment_account_id'), // Xendit sub-account / Stripe Connect account
    // Relay billing
    monthlyFeeCents: integer('monthly_fee_cents').notNull().default(0),
    perJobFeeCents: integer('per_job_fee_cents').notNull().default(0), // per recovered job
    createdAt: createdAt(),
  },
  (t) => [
    check('tenants_slug_format', sql`${t.slug} ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'`),
    check('tenants_slug_not_reserved', sql`${t.slug} not in ('admin', 'api', 'www')`),
    check('tenants_status_valid', oneOf(t.status, TENANT_STATUSES)),
    check('tenants_currency_format', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check('tenants_custom_domain_lowercase', sql`${t.customDomain} = lower(${t.customDomain})`),
    check('tenants_contact_phone_e164', e164(t.contactPhone)),
    check('tenants_office_phone_e164', e164(t.officePhone)),
    check('tenants_on_call_phone_e164', e164(t.onCallPhone)),
    check('tenants_office_ring_seconds_positive', sql`${t.officeRingSeconds} > 0`),
    check('tenants_texting_status_valid', oneOf(t.textingStatus, TEXTING_STATUSES)),
    check('tenants_hold_minutes_positive', sql`${t.holdMinutes} > 0`),
    check('tenants_priority_fee_not_negative', sql`${t.priorityFeeCents} >= 0`),
    check('tenants_quiet_hours_window', sql`${t.quietHoursStart} <> ${t.quietHoursEnd}`),
    check('tenants_payment_provider_valid', oneOf(t.paymentProvider, PAYMENT_PROVIDERS)),
    check('tenants_fees_not_negative', sql`${t.monthlyFeeCents} >= 0 and ${t.perJobFeeCents} >= 0`),
  ],
)

export const USER_ROLES = ['owner', 'office', 'technician', 'superadmin'] as const

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').references(() => tenants.id), // null only for the superadmin
    role: text('role', { enum: USER_ROLES }).notNull(),
    name: text('name').notNull(),
    email: text('email').unique(), // office sign-in; technicians may have none
    phone: text('phone').unique(), // technician SMS sign-in and alerts
    passwordHash: text('password_hash'), // scrypt params + salt + hash
    address: text('address'), // required for technicians (users_technician_profile)
    emergencyContactName: text('emergency_contact_name'), // required for technicians
    emergencyContactPhone: text('emergency_contact_phone'), // required for technicians
    disabledAt: timestamptz('disabled_at'), // deactivated users keep their history
    createdAt: createdAt(),
  },
  (t) => [
    unique().on(t.tenantId, t.id),
    check('users_role_valid', oneOf(t.role, USER_ROLES)),
    // Superadmins belong to Relay, everyone else to exactly one contractor.
    check('users_tenant_matches_role', sql`(${t.role} = 'superadmin') = (${t.tenantId} is null)`),
    check('users_email_lowercase', sql`${t.email} = lower(${t.email})`),
    check('users_phone_e164', e164(t.phone)),
    check('users_emergency_contact_phone_e164', e164(t.emergencyContactPhone)),
    // Owners and office staff don't need these; technicians must have all three.
    check(
      'users_technician_profile',
      sql`${t.role} <> 'technician' or (${t.address} is not null and ${t.emergencyContactName} is not null and ${t.emergencyContactPhone} is not null)`,
    ),
    check(
      'users_sign_in_method',
      sql`(${t.role} = 'technician' and ${t.phone} is not null) or (${t.role} <> 'technician' and ${t.email} is not null)`,
    ),
  ],
)

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(), // sha256 of the token; the token itself only lives in the cookie
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamptz('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check('sessions_id_format', sql`${t.id} ~ '^[0-9a-f]{64}$'`),
    index('sessions_user_id_idx').on(t.userId),
  ],
)

export const signInCodes = pgTable(
  'sign_in_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(), // HMAC-SHA256 of the 6-digit code with a server secret
    attempts: smallint('attempts').notNull().default(0),
    expiresAt: timestamptz('expires_at').notNull(),
    usedAt: timestamptz('used_at'),
    createdAt: createdAt(),
  },
  (t) => [index('sign_in_codes_user_id_idx').on(t.userId)],
)

export const PROFILE_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const
export const PROFILE_PHOTO_MAX_BYTES = 512 * 1024

// A user's profile photo, one each. The browser shrinks it before upload, so the bytes live
// here until file storage is chosen (Supabase Storage or Cloudflare R2).
export const userPhotos = pgTable(
  'user_photos',
  {
    userId: uuid('user_id').primaryKey(),
    tenantId: tenantId(),
    contentType: text('content_type', { enum: PROFILE_PHOTO_TYPES }).notNull(),
    data: bytea('data').notNull(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'user_photos_user_fk',
      columns: [t.tenantId, t.userId],
      foreignColumns: [users.tenantId, users.id],
    }),
    check('user_photos_content_type_valid', oneOf(t.contentType, PROFILE_PHOTO_TYPES)),
    check(
      'user_photos_size',
      sql`octet_length(${t.data}) between 1 and ${sql.raw(String(PROFILE_PHOTO_MAX_BYTES))}`,
    ),
  ],
)

// Append-only: the newest row per tenant is the current branding.
export const brandingVersions = pgTable(
  'branding_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    primaryColor: text('primary_color').notNull(),
    accentColor: text('accent_color').notNull(),
    logoUrl: text('logo_url'),
    faviconUrl: text('favicon_url'),
    // Plain FK: the author is a superadmin, who has no tenant.
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    check('branding_versions_primary_color_format', sql`${t.primaryColor} ~ '^#[0-9a-f]{6}$'`),
    check('branding_versions_accent_color_format', sql`${t.accentColor} ~ '^#[0-9a-f]{6}$'`),
    index('branding_versions_tenant_newest_idx').on(t.tenantId, t.createdAt.desc().nullsFirst()),
  ],
)

export const PHONE_NUMBER_STATUSES = ['porting', 'active', 'released'] as const

export const phoneNumbers = pgTable(
  'phone_numbers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    number: text('number').notNull(), // Twilio webhooks find the tenant by this
    providerSid: text('provider_sid').unique(), // Twilio IncomingPhoneNumber SID
    status: text('status', { enum: PHONE_NUMBER_STATUSES }).notNull().default('active'),
    createdAt: createdAt(),
  },
  (t) => [
    check('phone_numbers_number_e164', e164(t.number)),
    check('phone_numbers_status_valid', oneOf(t.status, PHONE_NUMBER_STATUSES)),
    // A number belongs to one contractor at a time.
    uniqueIndex('phone_numbers_number_in_use_key')
      .on(t.number)
      .where(sql`${t.status} <> 'released'`),
  ],
)

// Also used by contractor invoices (module 9).
export const INVOICE_STATUSES = ['open', 'paid', 'void'] as const

export const subscriptionInvoices = pgTable(
  'subscription_invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    periodStart: date('period_start').notNull(),
    periodEnd: date('period_end').notNull(),
    monthlyFeeCents: integer('monthly_fee_cents').notNull(),
    recoveredJobs: integer('recovered_jobs').notNull(), // metered count, frozen when the invoice is made
    perJobFeeCents: integer('per_job_fee_cents').notNull(),
    totalCents: integer('total_cents').notNull(),
    status: text('status', { enum: INVOICE_STATUSES }).notNull().default('open'),
    providerInvoiceId: text('provider_invoice_id'),
    paidAt: timestamptz('paid_at'),
    createdAt: createdAt(),
  },
  (t) => [
    unique().on(t.tenantId, t.periodStart),
    check('subscription_invoices_period_order', sql`${t.periodEnd} > ${t.periodStart}`),
    check('subscription_invoices_status_valid', oneOf(t.status, INVOICE_STATUSES)),
    check(
      'subscription_invoices_total_matches',
      sql`${t.totalCents} = ${t.monthlyFeeCents} + ${t.recoveredJobs} * ${t.perJobFeeCents}`,
    ),
    check(
      'subscription_invoices_paid_at_matches',
      sql`(${t.status} = 'paid') = (${t.paidAt} is not null)`,
    ),
  ],
)

// =====================================================================
// 2 · Online booking   6 · Scheduling and dispatch (setup tables)
// =====================================================================

// A fixed price, or a diagnostic fee with the repair priced on site.
export const PRICE_TYPES = ['fixed', 'diagnostic', 'free'] as const

export const services = pgTable(
  'services',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    name: text('name').notNull(), // 'AC repair', 'Tune-up', 'New-system estimate'
    description: text('description'),
    priceType: text('price_type', { enum: PRICE_TYPES }).notNull(),
    priceCents: integer('price_cents').notNull(),
    sortOrder: smallint('sort_order').notNull().default(0),
    archivedAt: timestamptz('archived_at'), // hidden from booking; old jobs still point here
    createdAt: createdAt(),
  },
  (t) => [
    unique().on(t.tenantId, t.id),
    check('services_price_type_valid', oneOf(t.priceType, PRICE_TYPES)),
    check('services_price_matches_type', sql`(${t.priceType} = 'free') = (${t.priceCents} = 0)`),
    check('services_price_not_negative', sql`${t.priceCents} >= 0`),
  ],
)

export const priceItems = pgTable(
  'price_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    name: text('name').notNull(), // 'Capacitor replacement'
    priceCents: integer('price_cents').notNull(),
    archivedAt: timestamptz('archived_at'),
    createdAt: createdAt(),
  },
  (t) => [
    unique().on(t.tenantId, t.id),
    check('price_items_price_not_negative', sql`${t.priceCents} >= 0`),
  ],
)

export const serviceAreaZips = pgTable(
  'service_area_zips',
  {
    tenantId: tenantId(),
    zip: text('zip').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.zip] }),
    check('service_area_zips_zip_format', sql`${t.zip} ~ '^[0-9]{5}$'`),
  ],
)

// Office hours: outside them the AI answers right away. No row for a weekday means closed.
export const businessHours = pgTable(
  'business_hours',
  {
    tenantId: tenantId(),
    weekday: smallint('weekday').notNull(), // 0 = Sunday … 6 = Saturday
    opensAt: time('opens_at').notNull(), // tenant local time
    closesAt: time('closes_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.weekday] }),
    check('business_hours_weekday_range', sql`${t.weekday} between 0 and 6`),
    check('business_hours_order', sql`${t.closesAt} > ${t.opensAt}`),
  ],
)

// Bookable arrival windows. To book, the service locks the window row (select … for update),
// counts active jobs in that window on that date, then inserts the hold, so web and AI can
// never both take the last slot.
export const arrivalWindows = pgTable(
  'arrival_windows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    weekday: smallint('weekday').notNull(),
    startsAt: time('starts_at').notNull(), // tenant local time
    endsAt: time('ends_at').notNull(),
    jobCap: smallint('job_cap').notNull(), // jobs per window
  },
  (t) => [
    unique().on(t.tenantId, t.weekday, t.startsAt),
    check('arrival_windows_weekday_range', sql`${t.weekday} between 0 and 6`),
    check('arrival_windows_order', sql`${t.endsAt} > ${t.startsAt}`),
    check('arrival_windows_job_cap_positive', sql`${t.jobCap} > 0`),
  ],
)

// =====================================================================
// 7 · Customers
// =====================================================================

// How the record was first created.
export const CUSTOMER_SOURCES = ['booking', 'call', 'office', 'import'] as const

export const customers = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    phone: text('phone'), // matched against callers and texts
    email: text('email'),
    notes: text('notes'),
    source: text('source', { enum: CUSTOMER_SOURCES }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique().on(t.tenantId, t.id),
    check('customers_phone_e164', e164(t.phone)),
    check('customers_email_lowercase', sql`${t.email} = lower(${t.email})`),
    check('customers_source_valid', oneOf(t.source, CUSTOMER_SOURCES)),
    // Not unique: spreadsheet imports and shared household phones can repeat.
    index('customers_tenant_phone_idx').on(t.tenantId, t.phone),
  ],
)

// Service address, with the simple equipment field.
export const properties = pgTable(
  'properties',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    customerId: uuid('customer_id').notNull(),
    street: text('street').notNull(),
    unit: text('unit'),
    city: text('city').notNull(),
    state: text('state').notNull(),
    zip: text('zip').notNull(),
    equipmentBrand: text('equipment_brand'),
    equipmentYear: smallint('equipment_year'), // approximate install year; age = now − year
    notes: text('notes'), // gate code, dog, attic access
    createdAt: createdAt(),
  },
  (t) => [
    unique().on(t.tenantId, t.customerId, t.id),
    foreignKey({
      name: 'properties_customer_fk',
      columns: [t.tenantId, t.customerId],
      foreignColumns: [customers.tenantId, customers.id],
    }),
    check('properties_state_format', sql`${t.state} ~ '^[A-Z]{2}$'`),
    check('properties_zip_format', sql`${t.zip} ~ '^[0-9]{5}$'`),
    check('properties_equipment_year_range', sql`${t.equipmentYear} between 1950 and 2100`),
  ],
)

// =====================================================================
// 3 · Missed-call text-back   4 · AI receptionist
// =====================================================================

export const CALL_ANSWERERS = ['office', 'ai'] as const

export const calls = pgTable(
  'calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    customerId: uuid('customer_id'), // matched by caller number, if known
    providerSid: text('provider_sid').notNull().unique(), // Twilio CallSid
    fromPhone: text('from_phone'), // null = caller ID blocked
    toPhone: text('to_phone').notNull(), // the contractor number that was called
    answeredBy: text('answered_by', { enum: CALL_ANSWERERS }), // null = hung up while it rang (missed)
    transferredAt: timestamptz('transferred_at'), // AI handed the call to staff or on-call
    safetyFlag: boolean('safety_flag').notNull().default(false), // gas or CO: safety script, never booked
    priority: boolean('priority').notNull().default(false), // vulnerable person with no heat or cooling
    disclosedAt: timestamptz('disclosed_at'), // "this is an AI and the call is recorded"
    recordingKey: text('recording_key'), // private file-storage key
    transcript: text('transcript'),
    summary: text('summary'), // AI summary, also added to the job notes
    startedAt: timestamptz('started_at').notNull().defaultNow(),
    endedAt: timestamptz('ended_at'),
  },
  (t) => [
    unique().on(t.tenantId, t.id),
    foreignKey({
      name: 'calls_customer_fk',
      columns: [t.tenantId, t.customerId],
      foreignColumns: [customers.tenantId, customers.id],
    }),
    check('calls_answered_by_valid', oneOf(t.answeredBy, CALL_ANSWERERS)),
    check('calls_ai_disclosed', sql`${t.answeredBy} <> 'ai' or ${t.disclosedAt} is not null`),
    check('calls_from_phone_e164', e164(t.fromPhone)),
    check('calls_to_phone_e164', e164(t.toPhone)),
    index('calls_tenant_started_idx').on(t.tenantId, t.startedAt.desc().nullsFirst()),
  ],
)

// =====================================================================
// 2 · Online booking   6 · Dispatch   8 · Technician job page
// One row per visit: held → booked → en_route → in_progress → done
// =====================================================================

export const JOB_STATUSES = [
  'held',
  'expired',
  'booked',
  'en_route',
  'in_progress',
  'no_access',
  'done',
  'cancelled',
] as const
// Feeds the recovered-revenue dashboard and the per-job fee.
export const JOB_SOURCES = ['web', 'text_back', 'ai', 'recovery_text', 'office'] as const
export const SYSTEM_TYPES = [
  'central_ac',
  'heat_pump',
  'furnace',
  'boiler',
  'mini_split',
  'other',
  'not_sure',
] as const

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    customerId: uuid('customer_id').notNull(),
    propertyId: uuid('property_id').notNull(),
    serviceId: uuid('service_id').notNull(),
    technicianId: uuid('technician_id'), // null until the office assigns one
    callId: uuid('call_id'), // the call it came from (AI, office or text-back)
    status: text('status', { enum: JOB_STATUSES }).notNull().default('held'),
    source: text('source', { enum: JOB_SOURCES }).notNull(),
    priority: boolean('priority').notNull().default(false),
    // The contractor's priority fee when the homeowner chose priority service, copied at the
    // time so a later fee change doesn't rewrite it. 0 = not chosen.
    priorityFeeCents: integer('priority_fee_cents').notNull().default(0),
    // Intake
    problem: text('problem').notNull(),
    systemType: text('system_type', { enum: SYSTEM_TYPES }).notNull(),
    vulnerableOccupant: boolean('vulnerable_occupant').notNull().default(false),
    // Schedule
    windowStartsAt: timestamptz('window_starts_at').notNull(),
    windowEndsAt: timestamptz('window_ends_at').notNull(),
    etaAt: timestamptz('eta_at'), // set by 'On my way' / 'Running late'
    holdExpiresAt: timestamptz('hold_expires_at'),
    // Links: sha256 of random tokens, cleared when the job closes.
    techLinkHash: text('tech_link_hash').unique(), // technician job page
    manageLinkHash: text('manage_link_hash').unique(), // homeowner reschedule / cancel
    createdBy: uuid('created_by'), // office user; null = homeowner or AI
    bookedAt: timestamptz('booked_at'),
    completedAt: timestamptz('completed_at'),
    createdAt: createdAt(),
  },
  (t) => [
    unique().on(t.tenantId, t.id),
    // One FK checks the tenant AND that the property belongs to this customer.
    foreignKey({
      name: 'jobs_property_fk',
      columns: [t.tenantId, t.customerId, t.propertyId],
      foreignColumns: [properties.tenantId, properties.customerId, properties.id],
    }),
    foreignKey({
      name: 'jobs_service_fk',
      columns: [t.tenantId, t.serviceId],
      foreignColumns: [services.tenantId, services.id],
    }),
    foreignKey({
      name: 'jobs_technician_fk',
      columns: [t.tenantId, t.technicianId],
      foreignColumns: [users.tenantId, users.id],
    }),
    foreignKey({
      name: 'jobs_call_fk',
      columns: [t.tenantId, t.callId],
      foreignColumns: [calls.tenantId, calls.id],
    }),
    foreignKey({
      name: 'jobs_created_by_fk',
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    check('jobs_status_valid', oneOf(t.status, JOB_STATUSES)),
    check('jobs_source_valid', oneOf(t.source, JOB_SOURCES)),
    check('jobs_system_type_valid', oneOf(t.systemType, SYSTEM_TYPES)),
    check('jobs_window_order', sql`${t.windowEndsAt} > ${t.windowStartsAt}`),
    check('jobs_priority_fee_not_negative', sql`${t.priorityFeeCents} >= 0`),
    check('jobs_priority_fee_needs_priority', sql`${t.priorityFeeCents} = 0 or ${t.priority}`),
    check('jobs_hold_has_expiry', sql`${t.status} <> 'held' or ${t.holdExpiresAt} is not null`),
    check(
      'jobs_visit_has_technician',
      sql`${t.status} not in ('en_route', 'in_progress', 'done') or ${t.technicianId} is not null`,
    ),
    check(
      'jobs_closed_links_cleared',
      sql`${t.status} not in ('done', 'cancelled', 'expired') or (${t.techLinkHash} is null and ${t.manageLinkHash} is null)`,
    ),
    index('jobs_tenant_window_idx').on(t.tenantId, t.windowStartsAt),
    index('jobs_tenant_technician_window_idx').on(t.tenantId, t.technicianId, t.windowStartsAt),
    index('jobs_tenant_customer_idx').on(t.tenantId, t.customerId),
  ],
)

// The homeowner approves or declines on site.
export const JOB_ITEM_STATUSES = ['proposed', 'approved', 'declined'] as const

// The booked service line plus repairs added from the price list.
export const jobItems = pgTable(
  'job_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    jobId: uuid('job_id').notNull(),
    priceItemId: uuid('price_item_id'), // null for the booked service line
    // Copied at the time, so later price changes don't rewrite history.
    description: text('description').notNull(),
    quantity: smallint('quantity').notNull().default(1),
    unitPriceCents: integer('unit_price_cents').notNull(),
    status: text('status', { enum: JOB_ITEM_STATUSES }).notNull().default('proposed'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'job_items_job_fk',
      columns: [t.tenantId, t.jobId],
      foreignColumns: [jobs.tenantId, jobs.id],
    }),
    foreignKey({
      name: 'job_items_price_item_fk',
      columns: [t.tenantId, t.priceItemId],
      foreignColumns: [priceItems.tenantId, priceItems.id],
    }),
    foreignKey({
      name: 'job_items_created_by_fk',
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    check('job_items_status_valid', oneOf(t.status, JOB_ITEM_STATUSES)),
    check('job_items_quantity_positive', sql`${t.quantity} > 0`),
    check('job_items_price_not_negative', sql`${t.unitPriceCents} >= 0`),
    index('job_items_job_idx').on(t.tenantId, t.jobId),
  ],
)

export const jobNotes = pgTable(
  'job_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    jobId: uuid('job_id').notNull(),
    authorId: uuid('author_id'), // null = AI call summary
    body: text('body').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'job_notes_job_fk',
      columns: [t.tenantId, t.jobId],
      foreignColumns: [jobs.tenantId, jobs.id],
    }),
    foreignKey({
      name: 'job_notes_author_fk',
      columns: [t.tenantId, t.authorId],
      foreignColumns: [users.tenantId, users.id],
    }),
    index('job_notes_job_idx').on(t.tenantId, t.jobId),
  ],
)

export const PHOTO_STAGES = ['before', 'after'] as const

export const jobPhotos = pgTable(
  'job_photos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    jobId: uuid('job_id').notNull(),
    storageKey: text('storage_key').notNull(), // private file-storage key, served by signed URL
    stage: text('stage', { enum: PHOTO_STAGES }).notNull(),
    uploadedBy: uuid('uploaded_by').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'job_photos_job_fk',
      columns: [t.tenantId, t.jobId],
      foreignColumns: [jobs.tenantId, jobs.id],
    }),
    foreignKey({
      name: 'job_photos_uploaded_by_fk',
      columns: [t.tenantId, t.uploadedBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    check('job_photos_stage_valid', oneOf(t.stage, PHOTO_STAGES)),
    index('job_photos_job_idx').on(t.tenantId, t.jobId),
  ],
)

export const WAITLIST_STATUSES = ['waiting', 'offered', 'booked', 'removed'] as const

export const waitlistEntries = pgTable(
  'waitlist_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    customerId: uuid('customer_id').notNull(),
    serviceId: uuid('service_id').notNull(),
    zip: text('zip').notNull(),
    priority: boolean('priority').notNull().default(false), // lets "first-come or priority-first" go either way
    status: text('status', { enum: WAITLIST_STATUSES }).notNull().default('waiting'),
    offeredAt: timestamptz('offered_at'),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'waitlist_entries_customer_fk',
      columns: [t.tenantId, t.customerId],
      foreignColumns: [customers.tenantId, customers.id],
    }),
    foreignKey({
      name: 'waitlist_entries_service_fk',
      columns: [t.tenantId, t.serviceId],
      foreignColumns: [services.tenantId, services.id],
    }),
    check('waitlist_entries_status_valid', oneOf(t.status, WAITLIST_STATUSES)),
    check('waitlist_entries_zip_format', sql`${t.zip} ~ '^[0-9]{5}$'`),
    index('waitlist_entries_waiting_idx')
      .on(t.tenantId, t.createdAt)
      .where(sql`${t.status} = 'waiting'`),
  ],
)

export const CALLBACK_SOURCES = ['ai', 'web'] as const

// AI take_message, and the web "outside our area" form.
export const callbackRequests = pgTable(
  'callback_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    callId: uuid('call_id'),
    name: text('name'),
    phone: text('phone').notNull(),
    zip: text('zip'),
    message: text('message').notNull(),
    source: text('source', { enum: CALLBACK_SOURCES }).notNull(),
    resolvedAt: timestamptz('resolved_at'),
    resolvedBy: uuid('resolved_by'),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'callback_requests_call_fk',
      columns: [t.tenantId, t.callId],
      foreignColumns: [calls.tenantId, calls.id],
    }),
    foreignKey({
      name: 'callback_requests_resolved_by_fk',
      columns: [t.tenantId, t.resolvedBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    check('callback_requests_source_valid', oneOf(t.source, CALLBACK_SOURCES)),
    check('callback_requests_ai_has_call', sql`${t.source} <> 'ai' or ${t.callId} is not null`),
    check('callback_requests_phone_e164', e164(t.phone)),
    index('callback_requests_open_idx')
      .on(t.tenantId, t.createdAt)
      .where(sql`${t.resolvedAt} is null`),
  ],
)

// What the booking wizard has been told so far. Every key is optional: a draft starts empty.
// The arrival window is left out on purpose: open windows change, so a homeowner who comes
// back picks one again.
export type DraftAnswers = {
  serviceId?: string
  problem?: string
  systemType?: (typeof SYSTEM_TYPES)[number]
  vulnerableOccupant?: boolean
  priorityService?: boolean
}

// An online booking somebody started and hasn't finished. Saved once they give a name and
// phone, so a refresh resumes it and a recovery text can bring them back.
export const bookingDrafts = pgTable(
  'booking_drafts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    // 32 random bytes as hex: the only key the browser and the resume link know. Stored as it
    // is, unlike job links: the recovery job needs it to build the link, and it opens nothing
    // this row doesn't already hold.
    token: text('token').notNull().unique(),
    name: text('name').notNull(),
    phone: text('phone').notNull(),
    zip: text('zip').notNull(),
    answers: jsonb('answers').$type<DraftAnswers>().notNull().default({}),
    smsConsent: boolean('sms_consent').notNull().default(false), // proof is in consent_events
    lastActivityAt: timestamptz('last_activity_at').notNull().defaultNow(),
    recoveryTextedAt: timestamptz('recovery_texted_at'), // null = not texted yet
    bookedJobId: uuid('booked_job_id'), // set when the booking is made
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'booking_drafts_booked_job_fk',
      columns: [t.tenantId, t.bookedJobId],
      foreignColumns: [jobs.tenantId, jobs.id],
    }),
    check('booking_drafts_phone_e164', e164(t.phone)),
    check('booking_drafts_zip_format', sql`${t.zip} ~ '^[0-9]{5}$'`),
    // The recovery job's queue: drafts that may still get their one text.
    index('booking_drafts_recovery_idx')
      .on(t.lastActivityAt)
      .where(sql`${t.smsConsent} and ${t.bookedJobId} is null and ${t.recoveryTextedAt} is null`),
  ],
)

// =====================================================================
// 3 · Two-way text inbox   10 · Notifications
// Every SMS and email, both directions. Outbound rows are written by the compliance gate;
// sign-in code bodies are stored masked.
// =====================================================================

export const MESSAGE_CHANNELS = ['sms', 'email'] as const
export const MESSAGE_DIRECTIONS = ['inbound', 'outbound'] as const
export const MESSAGE_STATUSES = [
  'queued',
  'sent',
  'delivered',
  'failed',
  'blocked',
  'received',
] as const
// Why the compliance gate stopped a message.
export const MESSAGE_BLOCKED_REASONS = ['no_consent', 'opted_out'] as const
export const MESSAGE_KINDS = [
  'inbound',
  'manual',
  'text_back',
  'missed_caller_reminder',
  'abandoned_booking',
  'waitlist_offer',
  'booking_confirmation',
  'booking_changed',
  'reminder',
  'card_link',
  'on_my_way',
  'running_late',
  'job_started',
  'no_access',
  'invoice',
  'payment_reminder',
  'review_request',
  'job_assigned',
  'new_booking_alert',
  'priority_alert',
  'sign_in_code',
] as const

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    channel: text('channel', { enum: MESSAGE_CHANNELS }).notNull(),
    direction: text('direction', { enum: MESSAGE_DIRECTIONS }).notNull(),
    contact: text('contact').notNull(), // the other side: phone (E.164) or email
    kind: text('kind', { enum: MESSAGE_KINDS }).notNull(),
    subject: text('subject'), // email only
    body: text('body').notNull(),
    status: text('status', { enum: MESSAGE_STATUSES }).notNull(),
    blockedReason: text('blocked_reason', { enum: MESSAGE_BLOCKED_REASONS }),
    providerMessageId: text('provider_message_id').unique(), // Twilio MessageSid / email Message-ID
    customerId: uuid('customer_id'),
    jobId: uuid('job_id'),
    callId: uuid('call_id'), // the call a text-back answers
    toUserId: uuid('to_user_id'), // staff or technician alerts
    sentByUserId: uuid('sent_by_user_id'), // office reply typed in the inbox
    readAt: timestamptz('read_at'), // inbound only: inbox unread state
    createdAt: createdAt(),
  },
  (t) => [
    unique().on(t.tenantId, t.id),
    foreignKey({
      name: 'messages_customer_fk',
      columns: [t.tenantId, t.customerId],
      foreignColumns: [customers.tenantId, customers.id],
    }),
    foreignKey({
      name: 'messages_job_fk',
      columns: [t.tenantId, t.jobId],
      foreignColumns: [jobs.tenantId, jobs.id],
    }),
    foreignKey({
      name: 'messages_call_fk',
      columns: [t.tenantId, t.callId],
      foreignColumns: [calls.tenantId, calls.id],
    }),
    foreignKey({
      name: 'messages_to_user_fk',
      columns: [t.tenantId, t.toUserId],
      foreignColumns: [users.tenantId, users.id],
    }),
    foreignKey({
      name: 'messages_sent_by_user_fk',
      columns: [t.tenantId, t.sentByUserId],
      foreignColumns: [users.tenantId, users.id],
    }),
    check('messages_channel_valid', oneOf(t.channel, MESSAGE_CHANNELS)),
    check('messages_direction_valid', oneOf(t.direction, MESSAGE_DIRECTIONS)),
    check('messages_status_valid', oneOf(t.status, MESSAGE_STATUSES)),
    check(
      'messages_inbound_is_received',
      sql`(${t.direction} = 'inbound') = (${t.status} = 'received')`,
    ),
    check(
      'messages_blocked_has_reason',
      sql`(${t.status} = 'blocked') = (${t.blockedReason} is not null)`,
    ),
    check('messages_blocked_reason_valid', oneOf(t.blockedReason, MESSAGE_BLOCKED_REASONS)),
    check('messages_kind_valid', oneOf(t.kind, MESSAGE_KINDS)),
    index('messages_thread_idx').on(t.tenantId, t.contact, t.createdAt.desc().nullsFirst()),
    index('messages_job_idx').on(t.tenantId, t.jobId),
  ],
)

// =====================================================================
// 9 · Payments (tokens only; card numbers never reach Relay)
// =====================================================================

export const paymentMethods = pgTable(
  'payment_methods',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    customerId: uuid('customer_id').notNull(),
    provider: text('provider', { enum: PAYMENT_PROVIDERS }).notNull(),
    providerMethodId: text('provider_method_id').notNull(), // provider token
    brand: text('brand'), // 'visa'
    last4: text('last4'),
    expMonth: smallint('exp_month'),
    expYear: smallint('exp_year'),
    removedAt: timestamptz('removed_at'),
    createdAt: createdAt(),
  },
  (t) => [
    unique().on(t.tenantId, t.id),
    unique().on(t.provider, t.providerMethodId),
    foreignKey({
      name: 'payment_methods_customer_fk',
      columns: [t.tenantId, t.customerId],
      foreignColumns: [customers.tenantId, customers.id],
    }),
    check('payment_methods_provider_valid', oneOf(t.provider, PAYMENT_PROVIDERS)),
    check('payment_methods_last4_format', sql`${t.last4} ~ '^[0-9]{4}$'`),
    check('payment_methods_exp_month_range', sql`${t.expMonth} between 1 and 12`),
    index('payment_methods_customer_idx').on(t.tenantId, t.customerId),
  ],
)

export const invoices = pgTable(
  'invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    jobId: uuid('job_id').notNull(),
    number: integer('number').notNull(), // per contractor: 1, 2, 3 …
    totalCents: integer('total_cents').notNull(), // approved job items when it was issued
    status: text('status', { enum: INVOICE_STATUSES }).notNull().default('open'),
    paidAt: timestamptz('paid_at'),
    createdAt: createdAt(),
  },
  (t) => [
    unique().on(t.tenantId, t.id),
    unique().on(t.tenantId, t.jobId), // one invoice per job
    unique().on(t.tenantId, t.number),
    foreignKey({
      name: 'invoices_job_fk',
      columns: [t.tenantId, t.jobId],
      foreignColumns: [jobs.tenantId, jobs.id],
    }),
    check('invoices_status_valid', oneOf(t.status, INVOICE_STATUSES)),
    check('invoices_paid_at_matches', sql`(${t.status} = 'paid') = (${t.paidAt} is not null)`),
    check('invoices_total_not_negative', sql`${t.totalCents} >= 0`),
  ],
)

export const PAYMENT_LINK_PURPOSES = ['save_card', 'pay_deposit', 'pay_invoice'] as const
export const PAYMENT_LINK_STATUSES = ['open', 'completed', 'expired'] as const

// Provider-hosted pages sent by text: save a card, pay the diagnostic fee, pay an invoice.
export const paymentLinks = pgTable(
  'payment_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    jobId: uuid('job_id').notNull(),
    invoiceId: uuid('invoice_id'),
    purpose: text('purpose', { enum: PAYMENT_LINK_PURPOSES }).notNull(),
    provider: text('provider', { enum: PAYMENT_PROVIDERS }).notNull(),
    providerLinkId: text('provider_link_id').notNull(), // webhooks find the job by this
    url: text('url').notNull(),
    status: text('status', { enum: PAYMENT_LINK_STATUSES }).notNull().default('open'),
    expiresAt: timestamptz('expires_at'),
    completedAt: timestamptz('completed_at'),
    createdAt: createdAt(),
  },
  (t) => [
    unique().on(t.provider, t.providerLinkId),
    foreignKey({
      name: 'payment_links_job_fk',
      columns: [t.tenantId, t.jobId],
      foreignColumns: [jobs.tenantId, jobs.id],
    }),
    foreignKey({
      name: 'payment_links_invoice_fk',
      columns: [t.tenantId, t.invoiceId],
      foreignColumns: [invoices.tenantId, invoices.id],
    }),
    check('payment_links_purpose_valid', oneOf(t.purpose, PAYMENT_LINK_PURPOSES)),
    check(
      'payment_links_invoice_matches_purpose',
      sql`(${t.purpose} = 'pay_invoice') = (${t.invoiceId} is not null)`,
    ),
    check('payment_links_provider_valid', oneOf(t.provider, PAYMENT_PROVIDERS)),
    check('payment_links_status_valid', oneOf(t.status, PAYMENT_LINK_STATUSES)),
  ],
)

export const PAYMENT_STATUSES = ['pending', 'succeeded', 'failed', 'refunded'] as const

export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    jobId: uuid('job_id').notNull(),
    invoiceId: uuid('invoice_id'), // null for a deposit taken at booking
    paymentMethodId: uuid('payment_method_id'), // null when paid through a link
    amountCents: integer('amount_cents').notNull(),
    status: text('status', { enum: PAYMENT_STATUSES }).notNull(),
    provider: text('provider', { enum: PAYMENT_PROVIDERS }).notNull(),
    providerPaymentId: text('provider_payment_id').notNull(),
    failureReason: text('failure_reason'),
    succeededAt: timestamptz('succeeded_at'),
    createdAt: createdAt(),
  },
  (t) => [
    unique().on(t.provider, t.providerPaymentId),
    foreignKey({
      name: 'payments_job_fk',
      columns: [t.tenantId, t.jobId],
      foreignColumns: [jobs.tenantId, jobs.id],
    }),
    foreignKey({
      name: 'payments_invoice_fk',
      columns: [t.tenantId, t.invoiceId],
      foreignColumns: [invoices.tenantId, invoices.id],
    }),
    foreignKey({
      name: 'payments_payment_method_fk',
      columns: [t.tenantId, t.paymentMethodId],
      foreignColumns: [paymentMethods.tenantId, paymentMethods.id],
    }),
    check('payments_amount_positive', sql`${t.amountCents} > 0`),
    check('payments_status_valid', oneOf(t.status, PAYMENT_STATUSES)),
    check('payments_provider_valid', oneOf(t.provider, PAYMENT_PROVIDERS)),
    index('payments_job_idx').on(t.tenantId, t.jobId),
  ],
)

// =====================================================================
// 12 · Compliance
// =====================================================================

export const CONSENT_CHANNELS = ['sms', 'voice', 'email'] as const
export const CONSENT_SOURCES = ['booking_form', 'call', 'sms_reply', 'office', 'import'] as const

// Append-only consent log. Current consent = newest row per (tenant, contact, channel).
// A STOP reply writes granted = false for sms.
export const consentEvents = pgTable(
  'consent_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    contact: text('contact').notNull(), // phone (E.164) or email
    channel: text('channel', { enum: CONSENT_CHANNELS }).notNull(),
    granted: boolean('granted').notNull(),
    source: text('source', { enum: CONSENT_SOURCES }).notNull(),
    wording: text('wording'), // exact text shown or spoken, as proof
    jobId: uuid('job_id'),
    callId: uuid('call_id'),
    messageId: uuid('message_id'), // the STOP / START reply
    ip: inet('ip'), // web form submissions
    createdBy: uuid('created_by'), // office user, when entered by hand
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'consent_events_job_fk',
      columns: [t.tenantId, t.jobId],
      foreignColumns: [jobs.tenantId, jobs.id],
    }),
    foreignKey({
      name: 'consent_events_call_fk',
      columns: [t.tenantId, t.callId],
      foreignColumns: [calls.tenantId, calls.id],
    }),
    foreignKey({
      name: 'consent_events_message_fk',
      columns: [t.tenantId, t.messageId],
      foreignColumns: [messages.tenantId, messages.id],
    }),
    foreignKey({
      name: 'consent_events_created_by_fk',
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    check('consent_events_channel_valid', oneOf(t.channel, CONSENT_CHANNELS)),
    check('consent_events_source_valid', oneOf(t.source, CONSENT_SOURCES)),
    check(
      'consent_events_reply_has_message',
      sql`(${t.source} = 'sms_reply') = (${t.messageId} is not null)`,
    ),
    index('consent_events_lookup_idx').on(
      t.tenantId,
      t.contact,
      t.channel,
      t.createdAt.desc().nullsFirst(),
    ),
  ],
)

export const AUDIT_ACTOR_TYPES = ['user', 'homeowner', 'ai', 'system'] as const

// Append-only audit log: consent, messages, payments, branding, job status changes.
// A trigger (added in a hand-written migration) blocks update and delete; TRUNCATE still
// works, so tests can reset.
export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').references(() => tenants.id), // null for platform actions by the superadmin
    actorType: text('actor_type', { enum: AUDIT_ACTOR_TYPES }).notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id), // plain FK: the actor may be a superadmin
    action: text('action').notNull(), // 'job.assigned', 'message.sent', 'branding.updated'
    entityType: text('entity_type').notNull(), // 'job', 'message', 'payment', 'tenant'
    entityId: uuid('entity_id'),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    check('audit_events_actor_type_valid', oneOf(t.actorType, AUDIT_ACTOR_TYPES)),
    check(
      'audit_events_actor_user_matches',
      sql`(${t.actorType} = 'user') = (${t.actorUserId} is not null)`,
    ),
    index('audit_events_entity_idx').on(t.tenantId, t.entityType, t.entityId, t.createdAt),
  ],
)

export const WEBHOOK_PROVIDERS = ['twilio', 'xendit', 'stripe'] as const

// Webhook dedupe: insert first; a conflict means this event was already handled.
export const webhookEvents = pgTable(
  'webhook_events',
  {
    provider: text('provider', { enum: WEBHOOK_PROVIDERS }).notNull(),
    eventId: text('event_id').notNull(), // Twilio SID / Xendit event id
    receivedAt: timestamptz('received_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.eventId] }),
    check('webhook_events_provider_valid', oneOf(t.provider, WEBHOOK_PROVIDERS)),
  ],
)

export type Tenant = typeof tenants.$inferSelect
export type User = typeof users.$inferSelect
export type UserRole = User['role']
export type BrandingVersion = typeof brandingVersions.$inferSelect
