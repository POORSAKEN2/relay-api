CREATE TABLE "booking_photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"draft_id" uuid NOT NULL,
	"content_type" text NOT NULL,
	"data" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_photos_content_type_valid" CHECK ("booking_photos"."content_type" in ('image/jpeg', 'image/png', 'image/webp')),
	CONSTRAINT "booking_photos_size" CHECK (octet_length("booking_photos"."data") between 1 and 1048576)
);
--> statement-breakpoint
ALTER TABLE "booking_drafts" ADD CONSTRAINT "booking_drafts_tenant_id_id_unique" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "booking_photos" ADD CONSTRAINT "booking_photos_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_photos" ADD CONSTRAINT "booking_photos_draft_fk" FOREIGN KEY ("tenant_id","draft_id") REFERENCES "public"."booking_drafts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "booking_photos_draft_idx" ON "booking_photos" USING btree ("tenant_id","draft_id");