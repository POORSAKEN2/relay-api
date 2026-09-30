CREATE TABLE "booking_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"token" text NOT NULL,
	"name" text NOT NULL,
	"phone" text NOT NULL,
	"zip" text NOT NULL,
	"answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sms_consent" boolean DEFAULT false NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recovery_texted_at" timestamp with time zone,
	"booked_job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_drafts_token_unique" UNIQUE("token"),
	CONSTRAINT "booking_drafts_phone_e164" CHECK ("booking_drafts"."phone" ~ '^\+[1-9][0-9]{7,14}$'),
	CONSTRAINT "booking_drafts_zip_format" CHECK ("booking_drafts"."zip" ~ '^[0-9]{5}$')
);
--> statement-breakpoint
ALTER TABLE "booking_drafts" ADD CONSTRAINT "booking_drafts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_drafts" ADD CONSTRAINT "booking_drafts_booked_job_fk" FOREIGN KEY ("tenant_id","booked_job_id") REFERENCES "public"."jobs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "booking_drafts_recovery_idx" ON "booking_drafts" USING btree ("last_activity_at") WHERE "booking_drafts"."sms_consent" and "booking_drafts"."booked_job_id" is null and "booking_drafts"."recovery_texted_at" is null;