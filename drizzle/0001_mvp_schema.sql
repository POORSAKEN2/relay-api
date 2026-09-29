CREATE TABLE "arrival_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"weekday" smallint NOT NULL,
	"starts_at" time NOT NULL,
	"ends_at" time NOT NULL,
	"job_cap" smallint NOT NULL,
	CONSTRAINT "arrival_windows_tenant_id_weekday_starts_at_unique" UNIQUE("tenant_id","weekday","starts_at"),
	CONSTRAINT "arrival_windows_weekday_range" CHECK ("arrival_windows"."weekday" between 0 and 6),
	CONSTRAINT "arrival_windows_order" CHECK ("arrival_windows"."ends_at" > "arrival_windows"."starts_at"),
	CONSTRAINT "arrival_windows_job_cap_positive" CHECK ("arrival_windows"."job_cap" > 0)
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"actor_type" text NOT NULL,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_events_actor_type_valid" CHECK ("audit_events"."actor_type" in ('user', 'homeowner', 'ai', 'system')),
	CONSTRAINT "audit_events_actor_user_matches" CHECK (("audit_events"."actor_type" = 'user') = ("audit_events"."actor_user_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "business_hours" (
	"tenant_id" uuid NOT NULL,
	"weekday" smallint NOT NULL,
	"opens_at" time NOT NULL,
	"closes_at" time NOT NULL,
	CONSTRAINT "business_hours_tenant_id_weekday_pk" PRIMARY KEY("tenant_id","weekday"),
	CONSTRAINT "business_hours_weekday_range" CHECK ("business_hours"."weekday" between 0 and 6),
	CONSTRAINT "business_hours_order" CHECK ("business_hours"."closes_at" > "business_hours"."opens_at")
);
--> statement-breakpoint
CREATE TABLE "callback_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"call_id" uuid,
	"name" text,
	"phone" text NOT NULL,
	"zip" text,
	"message" text NOT NULL,
	"source" text NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "callback_requests_source_valid" CHECK ("callback_requests"."source" in ('ai', 'web')),
	CONSTRAINT "callback_requests_ai_has_call" CHECK ("callback_requests"."source" <> 'ai' or "callback_requests"."call_id" is not null),
	CONSTRAINT "callback_requests_phone_e164" CHECK ("callback_requests"."phone" ~ '^\+[1-9][0-9]{7,14}$')
);
--> statement-breakpoint
CREATE TABLE "calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid,
	"provider_sid" text NOT NULL,
	"from_phone" text,
	"to_phone" text NOT NULL,
	"answered_by" text,
	"transferred_at" timestamp with time zone,
	"safety_flag" boolean DEFAULT false NOT NULL,
	"priority" boolean DEFAULT false NOT NULL,
	"disclosed_at" timestamp with time zone,
	"recording_key" text,
	"transcript" text,
	"summary" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "calls_provider_sid_unique" UNIQUE("provider_sid"),
	CONSTRAINT "calls_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "calls_answered_by_valid" CHECK ("calls"."answered_by" in ('office', 'ai')),
	CONSTRAINT "calls_ai_disclosed" CHECK ("calls"."answered_by" <> 'ai' or "calls"."disclosed_at" is not null),
	CONSTRAINT "calls_from_phone_e164" CHECK ("calls"."from_phone" ~ '^\+[1-9][0-9]{7,14}$'),
	CONSTRAINT "calls_to_phone_e164" CHECK ("calls"."to_phone" ~ '^\+[1-9][0-9]{7,14}$')
);
--> statement-breakpoint
CREATE TABLE "consent_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"contact" text NOT NULL,
	"channel" text NOT NULL,
	"granted" boolean NOT NULL,
	"source" text NOT NULL,
	"wording" text,
	"job_id" uuid,
	"call_id" uuid,
	"message_id" uuid,
	"ip" "inet",
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consent_events_channel_valid" CHECK ("consent_events"."channel" in ('sms', 'voice', 'email')),
	CONSTRAINT "consent_events_source_valid" CHECK ("consent_events"."source" in ('booking_form', 'call', 'sms_reply', 'office', 'import')),
	CONSTRAINT "consent_events_reply_has_message" CHECK (("consent_events"."source" = 'sms_reply') = ("consent_events"."message_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"email" text,
	"notes" text,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customers_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "customers_phone_e164" CHECK ("customers"."phone" ~ '^\+[1-9][0-9]{7,14}$'),
	CONSTRAINT "customers_email_lowercase" CHECK ("customers"."email" = lower("customers"."email")),
	CONSTRAINT "customers_source_valid" CHECK ("customers"."source" in ('booking', 'call', 'office', 'import'))
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"total_cents" integer NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "invoices_tenant_id_job_id_unique" UNIQUE("tenant_id","job_id"),
	CONSTRAINT "invoices_tenant_id_number_unique" UNIQUE("tenant_id","number"),
	CONSTRAINT "invoices_status_valid" CHECK ("invoices"."status" in ('open', 'paid', 'void')),
	CONSTRAINT "invoices_paid_at_matches" CHECK (("invoices"."status" = 'paid') = ("invoices"."paid_at" is not null)),
	CONSTRAINT "invoices_total_not_negative" CHECK ("invoices"."total_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "job_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"price_item_id" uuid,
	"description" text NOT NULL,
	"quantity" smallint DEFAULT 1 NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_items_status_valid" CHECK ("job_items"."status" in ('proposed', 'approved', 'declined')),
	CONSTRAINT "job_items_quantity_positive" CHECK ("job_items"."quantity" > 0),
	CONSTRAINT "job_items_price_not_negative" CHECK ("job_items"."unit_price_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "job_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"author_id" uuid,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"stage" text NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_photos_stage_valid" CHECK ("job_photos"."stage" in ('before', 'after'))
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"technician_id" uuid,
	"call_id" uuid,
	"status" text DEFAULT 'held' NOT NULL,
	"source" text NOT NULL,
	"priority" boolean DEFAULT false NOT NULL,
	"problem" text NOT NULL,
	"system_type" text NOT NULL,
	"vulnerable_occupant" boolean DEFAULT false NOT NULL,
	"window_starts_at" timestamp with time zone NOT NULL,
	"window_ends_at" timestamp with time zone NOT NULL,
	"eta_at" timestamp with time zone,
	"hold_expires_at" timestamp with time zone,
	"tech_link_hash" text,
	"manage_link_hash" text,
	"created_by" uuid,
	"booked_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_tech_link_hash_unique" UNIQUE("tech_link_hash"),
	CONSTRAINT "jobs_manage_link_hash_unique" UNIQUE("manage_link_hash"),
	CONSTRAINT "jobs_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "jobs_status_valid" CHECK ("jobs"."status" in ('held', 'expired', 'booked', 'en_route', 'in_progress', 'no_access', 'done', 'cancelled')),
	CONSTRAINT "jobs_source_valid" CHECK ("jobs"."source" in ('web', 'text_back', 'ai', 'recovery_text', 'office')),
	CONSTRAINT "jobs_system_type_valid" CHECK ("jobs"."system_type" in ('central_ac', 'heat_pump', 'furnace', 'boiler', 'mini_split', 'other', 'not_sure')),
	CONSTRAINT "jobs_window_order" CHECK ("jobs"."window_ends_at" > "jobs"."window_starts_at"),
	CONSTRAINT "jobs_hold_has_expiry" CHECK ("jobs"."status" <> 'held' or "jobs"."hold_expires_at" is not null),
	CONSTRAINT "jobs_visit_has_technician" CHECK ("jobs"."status" not in ('en_route', 'in_progress', 'done') or "jobs"."technician_id" is not null),
	CONSTRAINT "jobs_closed_links_cleared" CHECK ("jobs"."status" not in ('done', 'cancelled', 'expired') or ("jobs"."tech_link_hash" is null and "jobs"."manage_link_hash" is null))
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"direction" text NOT NULL,
	"contact" text NOT NULL,
	"kind" text NOT NULL,
	"subject" text,
	"body" text NOT NULL,
	"status" text NOT NULL,
	"blocked_reason" text,
	"provider_message_id" text,
	"customer_id" uuid,
	"job_id" uuid,
	"call_id" uuid,
	"to_user_id" uuid,
	"sent_by_user_id" uuid,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_provider_message_id_unique" UNIQUE("provider_message_id"),
	CONSTRAINT "messages_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "messages_channel_valid" CHECK ("messages"."channel" in ('sms', 'email')),
	CONSTRAINT "messages_direction_valid" CHECK ("messages"."direction" in ('inbound', 'outbound')),
	CONSTRAINT "messages_status_valid" CHECK ("messages"."status" in ('queued', 'sent', 'delivered', 'failed', 'blocked', 'received')),
	CONSTRAINT "messages_inbound_is_received" CHECK (("messages"."direction" = 'inbound') = ("messages"."status" = 'received')),
	CONSTRAINT "messages_blocked_has_reason" CHECK (("messages"."status" = 'blocked') = ("messages"."blocked_reason" is not null)),
	CONSTRAINT "messages_blocked_reason_valid" CHECK ("messages"."blocked_reason" in ('no_consent', 'opted_out')),
	CONSTRAINT "messages_kind_valid" CHECK ("messages"."kind" in ('inbound', 'manual', 'text_back', 'missed_caller_reminder', 'abandoned_booking', 'waitlist_offer', 'booking_confirmation', 'booking_changed', 'reminder', 'card_link', 'on_my_way', 'running_late', 'job_started', 'no_access', 'invoice', 'payment_reminder', 'review_request', 'job_assigned', 'new_booking_alert', 'priority_alert', 'sign_in_code'))
);
--> statement-breakpoint
CREATE TABLE "payment_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"invoice_id" uuid,
	"purpose" text NOT NULL,
	"provider" text NOT NULL,
	"provider_link_id" text NOT NULL,
	"url" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"expires_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_links_provider_provider_link_id_unique" UNIQUE("provider","provider_link_id"),
	CONSTRAINT "payment_links_purpose_valid" CHECK ("payment_links"."purpose" in ('save_card', 'pay_deposit', 'pay_invoice')),
	CONSTRAINT "payment_links_invoice_matches_purpose" CHECK (("payment_links"."purpose" = 'pay_invoice') = ("payment_links"."invoice_id" is not null)),
	CONSTRAINT "payment_links_provider_valid" CHECK ("payment_links"."provider" in ('xendit', 'stripe')),
	CONSTRAINT "payment_links_status_valid" CHECK ("payment_links"."status" in ('open', 'completed', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "payment_methods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_method_id" text NOT NULL,
	"brand" text,
	"last4" text,
	"exp_month" smallint,
	"exp_year" smallint,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_methods_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "payment_methods_provider_provider_method_id_unique" UNIQUE("provider","provider_method_id"),
	CONSTRAINT "payment_methods_provider_valid" CHECK ("payment_methods"."provider" in ('xendit', 'stripe')),
	CONSTRAINT "payment_methods_last4_format" CHECK ("payment_methods"."last4" ~ '^[0-9]{4}$'),
	CONSTRAINT "payment_methods_exp_month_range" CHECK ("payment_methods"."exp_month" between 1 and 12)
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"invoice_id" uuid,
	"payment_method_id" uuid,
	"amount_cents" integer NOT NULL,
	"status" text NOT NULL,
	"provider" text NOT NULL,
	"provider_payment_id" text NOT NULL,
	"failure_reason" text,
	"succeeded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_provider_provider_payment_id_unique" UNIQUE("provider","provider_payment_id"),
	CONSTRAINT "payments_amount_positive" CHECK ("payments"."amount_cents" > 0),
	CONSTRAINT "payments_status_valid" CHECK ("payments"."status" in ('pending', 'succeeded', 'failed', 'refunded')),
	CONSTRAINT "payments_provider_valid" CHECK ("payments"."provider" in ('xendit', 'stripe'))
);
--> statement-breakpoint
CREATE TABLE "phone_numbers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"number" text NOT NULL,
	"provider_sid" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "phone_numbers_provider_sid_unique" UNIQUE("provider_sid"),
	CONSTRAINT "phone_numbers_number_e164" CHECK ("phone_numbers"."number" ~ '^\+[1-9][0-9]{7,14}$'),
	CONSTRAINT "phone_numbers_status_valid" CHECK ("phone_numbers"."status" in ('porting', 'active', 'released'))
);
--> statement-breakpoint
CREATE TABLE "price_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"price_cents" integer NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_items_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "price_items_price_not_negative" CHECK ("price_items"."price_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "properties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"street" text NOT NULL,
	"unit" text,
	"city" text NOT NULL,
	"state" text NOT NULL,
	"zip" text NOT NULL,
	"equipment_brand" text,
	"equipment_year" smallint,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "properties_tenant_id_customer_id_id_unique" UNIQUE("tenant_id","customer_id","id"),
	CONSTRAINT "properties_state_format" CHECK ("properties"."state" ~ '^[A-Z]{2}$'),
	CONSTRAINT "properties_zip_format" CHECK ("properties"."zip" ~ '^[0-9]{5}$'),
	CONSTRAINT "properties_equipment_year_range" CHECK ("properties"."equipment_year" between 1950 and 2100)
);
--> statement-breakpoint
CREATE TABLE "service_area_zips" (
	"tenant_id" uuid NOT NULL,
	"zip" text NOT NULL,
	CONSTRAINT "service_area_zips_tenant_id_zip_pk" PRIMARY KEY("tenant_id","zip"),
	CONSTRAINT "service_area_zips_zip_format" CHECK ("service_area_zips"."zip" ~ '^[0-9]{5}$')
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"price_type" text NOT NULL,
	"price_cents" integer NOT NULL,
	"sort_order" smallint DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "services_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "services_price_type_valid" CHECK ("services"."price_type" in ('fixed', 'diagnostic', 'free')),
	CONSTRAINT "services_price_matches_type" CHECK (("services"."price_type" = 'free') = ("services"."price_cents" = 0)),
	CONSTRAINT "services_price_not_negative" CHECK ("services"."price_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "sign_in_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"monthly_fee_cents" integer NOT NULL,
	"recovered_jobs" integer NOT NULL,
	"per_job_fee_cents" integer NOT NULL,
	"total_cents" integer NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"provider_invoice_id" text,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_invoices_tenant_id_period_start_unique" UNIQUE("tenant_id","period_start"),
	CONSTRAINT "subscription_invoices_period_order" CHECK ("subscription_invoices"."period_end" > "subscription_invoices"."period_start"),
	CONSTRAINT "subscription_invoices_status_valid" CHECK ("subscription_invoices"."status" in ('open', 'paid', 'void')),
	CONSTRAINT "subscription_invoices_total_matches" CHECK ("subscription_invoices"."total_cents" = "subscription_invoices"."monthly_fee_cents" + "subscription_invoices"."recovered_jobs" * "subscription_invoices"."per_job_fee_cents"),
	CONSTRAINT "subscription_invoices_paid_at_matches" CHECK (("subscription_invoices"."status" = 'paid') = ("subscription_invoices"."paid_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "waitlist_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"zip" text NOT NULL,
	"priority" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"offered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "waitlist_entries_status_valid" CHECK ("waitlist_entries"."status" in ('waiting', 'offered', 'booked', 'removed')),
	CONSTRAINT "waitlist_entries_zip_format" CHECK ("waitlist_entries"."zip" ~ '^[0-9]{5}$')
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_events_provider_event_id_pk" PRIMARY KEY("provider","event_id"),
	CONSTRAINT "webhook_events_provider_valid" CHECK ("webhook_events"."provider" in ('twilio', 'xendit', 'stripe'))
);
--> statement-breakpoint
DROP INDEX "branding_versions_tenant_id_created_at_idx";--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;--> statement-breakpoint
-- Hand edit: this check compares role with 'superadmin'::user_role, so it can't survive the
-- type change. Drop it, change the type, then add it back unchanged.
ALTER TABLE "users" DROP CONSTRAINT "users_tenant_matches_role";--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "role" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_matches_role" CHECK (("users"."role" = 'superadmin') = ("users"."tenant_id" is null));--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "status" text DEFAULT 'setup' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "currency" text DEFAULT 'USD' NOT NULL;--> statement-breakpoint
-- contact_email and contact_phone are required with no default, so this migration needs an
-- empty tenants table. Development databases: truncate, migrate, then npm run db:seed.
ALTER TABLE "tenants" ADD COLUMN "contact_email" text NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "contact_phone" text NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "custom_domain_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "office_phone" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "office_ring_seconds" smallint DEFAULT 15 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "on_call_phone" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "texting_status" text DEFAULT 'not_registered' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "messaging_service_sid" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "hold_minutes" smallint DEFAULT 15 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "quiet_hours_start" time DEFAULT '21:00' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "quiet_hours_end" time DEFAULT '08:00' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "review_url" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "payment_provider" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "payment_account_id" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "monthly_fee_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "per_job_fee_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "disabled_at" timestamp with time zone;--> statement-breakpoint
-- Hand edit: moved up from the constraint section, because the composite foreign keys below
-- reference users (tenant_id, id) and need this unique constraint to exist first.
ALTER TABLE "users" ADD CONSTRAINT "users_phone_unique" UNIQUE("phone");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_id_unique" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "arrival_windows" ADD CONSTRAINT "arrival_windows_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_hours" ADD CONSTRAINT "business_hours_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "callback_requests" ADD CONSTRAINT "callback_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "callback_requests" ADD CONSTRAINT "callback_requests_call_fk" FOREIGN KEY ("tenant_id","call_id") REFERENCES "public"."calls"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "callback_requests" ADD CONSTRAINT "callback_requests_resolved_by_fk" FOREIGN KEY ("tenant_id","resolved_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_events" ADD CONSTRAINT "consent_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_events" ADD CONSTRAINT "consent_events_job_fk" FOREIGN KEY ("tenant_id","job_id") REFERENCES "public"."jobs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_events" ADD CONSTRAINT "consent_events_call_fk" FOREIGN KEY ("tenant_id","call_id") REFERENCES "public"."calls"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_events" ADD CONSTRAINT "consent_events_message_fk" FOREIGN KEY ("tenant_id","message_id") REFERENCES "public"."messages"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_events" ADD CONSTRAINT "consent_events_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_job_fk" FOREIGN KEY ("tenant_id","job_id") REFERENCES "public"."jobs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_items" ADD CONSTRAINT "job_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_items" ADD CONSTRAINT "job_items_job_fk" FOREIGN KEY ("tenant_id","job_id") REFERENCES "public"."jobs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_items" ADD CONSTRAINT "job_items_price_item_fk" FOREIGN KEY ("tenant_id","price_item_id") REFERENCES "public"."price_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_items" ADD CONSTRAINT "job_items_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_notes" ADD CONSTRAINT "job_notes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_notes" ADD CONSTRAINT "job_notes_job_fk" FOREIGN KEY ("tenant_id","job_id") REFERENCES "public"."jobs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_notes" ADD CONSTRAINT "job_notes_author_fk" FOREIGN KEY ("tenant_id","author_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_photos" ADD CONSTRAINT "job_photos_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_photos" ADD CONSTRAINT "job_photos_job_fk" FOREIGN KEY ("tenant_id","job_id") REFERENCES "public"."jobs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_photos" ADD CONSTRAINT "job_photos_uploaded_by_fk" FOREIGN KEY ("tenant_id","uploaded_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_property_fk" FOREIGN KEY ("tenant_id","customer_id","property_id") REFERENCES "public"."properties"("tenant_id","customer_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_service_fk" FOREIGN KEY ("tenant_id","service_id") REFERENCES "public"."services"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_technician_fk" FOREIGN KEY ("tenant_id","technician_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_call_fk" FOREIGN KEY ("tenant_id","call_id") REFERENCES "public"."calls"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_job_fk" FOREIGN KEY ("tenant_id","job_id") REFERENCES "public"."jobs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_call_fk" FOREIGN KEY ("tenant_id","call_id") REFERENCES "public"."calls"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_to_user_fk" FOREIGN KEY ("tenant_id","to_user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sent_by_user_fk" FOREIGN KEY ("tenant_id","sent_by_user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_job_fk" FOREIGN KEY ("tenant_id","job_id") REFERENCES "public"."jobs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_invoice_fk" FOREIGN KEY ("tenant_id","invoice_id") REFERENCES "public"."invoices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_job_fk" FOREIGN KEY ("tenant_id","job_id") REFERENCES "public"."jobs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_fk" FOREIGN KEY ("tenant_id","invoice_id") REFERENCES "public"."invoices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_payment_method_fk" FOREIGN KEY ("tenant_id","payment_method_id") REFERENCES "public"."payment_methods"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_numbers" ADD CONSTRAINT "phone_numbers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_items" ADD CONSTRAINT "price_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_area_zips" ADD CONSTRAINT "service_area_zips_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sign_in_codes" ADD CONSTRAINT "sign_in_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_invoices" ADD CONSTRAINT "subscription_invoices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_service_fk" FOREIGN KEY ("tenant_id","service_id") REFERENCES "public"."services"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_entity_idx" ON "audit_events" USING btree ("tenant_id","entity_type","entity_id","created_at");--> statement-breakpoint
CREATE INDEX "callback_requests_open_idx" ON "callback_requests" USING btree ("tenant_id","created_at") WHERE "callback_requests"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "calls_tenant_started_idx" ON "calls" USING btree ("tenant_id","started_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "consent_events_lookup_idx" ON "consent_events" USING btree ("tenant_id","contact","channel","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "customers_tenant_phone_idx" ON "customers" USING btree ("tenant_id","phone");--> statement-breakpoint
CREATE INDEX "job_items_job_idx" ON "job_items" USING btree ("tenant_id","job_id");--> statement-breakpoint
CREATE INDEX "job_notes_job_idx" ON "job_notes" USING btree ("tenant_id","job_id");--> statement-breakpoint
CREATE INDEX "job_photos_job_idx" ON "job_photos" USING btree ("tenant_id","job_id");--> statement-breakpoint
CREATE INDEX "jobs_tenant_window_idx" ON "jobs" USING btree ("tenant_id","window_starts_at");--> statement-breakpoint
CREATE INDEX "jobs_tenant_technician_window_idx" ON "jobs" USING btree ("tenant_id","technician_id","window_starts_at");--> statement-breakpoint
CREATE INDEX "jobs_tenant_customer_idx" ON "jobs" USING btree ("tenant_id","customer_id");--> statement-breakpoint
CREATE INDEX "messages_thread_idx" ON "messages" USING btree ("tenant_id","contact","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "messages_job_idx" ON "messages" USING btree ("tenant_id","job_id");--> statement-breakpoint
CREATE INDEX "payment_methods_customer_idx" ON "payment_methods" USING btree ("tenant_id","customer_id");--> statement-breakpoint
CREATE INDEX "payments_job_idx" ON "payments" USING btree ("tenant_id","job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "phone_numbers_number_in_use_key" ON "phone_numbers" USING btree ("number") WHERE "phone_numbers"."status" <> 'released';--> statement-breakpoint
CREATE INDEX "sign_in_codes_user_id_idx" ON "sign_in_codes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "waitlist_entries_waiting_idx" ON "waitlist_entries" USING btree ("tenant_id","created_at") WHERE "waitlist_entries"."status" = 'waiting';--> statement-breakpoint
CREATE INDEX "branding_versions_tenant_newest_idx" ON "branding_versions" USING btree ("tenant_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "branding_versions" ADD CONSTRAINT "branding_versions_primary_color_format" CHECK ("branding_versions"."primary_color" ~ '^#[0-9a-f]{6}$');--> statement-breakpoint
ALTER TABLE "branding_versions" ADD CONSTRAINT "branding_versions_accent_color_format" CHECK ("branding_versions"."accent_color" ~ '^#[0-9a-f]{6}$');--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_id_format" CHECK ("sessions"."id" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_slug_format" CHECK ("tenants"."slug" ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$');--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_slug_not_reserved" CHECK ("tenants"."slug" not in ('admin', 'api', 'www'));--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_status_valid" CHECK ("tenants"."status" in ('setup', 'live', 'suspended'));--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_currency_format" CHECK ("tenants"."currency" ~ '^[A-Z]{3}$');--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_custom_domain_lowercase" CHECK ("tenants"."custom_domain" = lower("tenants"."custom_domain"));--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_contact_phone_e164" CHECK ("tenants"."contact_phone" ~ '^\+[1-9][0-9]{7,14}$');--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_office_phone_e164" CHECK ("tenants"."office_phone" ~ '^\+[1-9][0-9]{7,14}$');--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_on_call_phone_e164" CHECK ("tenants"."on_call_phone" ~ '^\+[1-9][0-9]{7,14}$');--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_office_ring_seconds_positive" CHECK ("tenants"."office_ring_seconds" > 0);--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_texting_status_valid" CHECK ("tenants"."texting_status" in ('not_registered', 'pending', 'approved', 'rejected'));--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_hold_minutes_positive" CHECK ("tenants"."hold_minutes" > 0);--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_quiet_hours_window" CHECK ("tenants"."quiet_hours_start" <> "tenants"."quiet_hours_end");--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_payment_provider_valid" CHECK ("tenants"."payment_provider" in ('xendit', 'stripe'));--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_fees_not_negative" CHECK ("tenants"."monthly_fee_cents" >= 0 and "tenants"."per_job_fee_cents" >= 0);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_valid" CHECK ("users"."role" in ('owner', 'office', 'technician', 'superadmin'));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_email_lowercase" CHECK ("users"."email" = lower("users"."email"));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_phone_e164" CHECK ("users"."phone" ~ '^\+[1-9][0-9]{7,14}$');--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_sign_in_method" CHECK (("users"."role" = 'technician' and "users"."phone" is not null) or ("users"."role" <> 'technician' and "users"."email" is not null));--> statement-breakpoint
DROP TYPE "public"."user_role";