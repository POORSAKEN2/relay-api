CREATE TABLE "user_photos" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"content_type" text NOT NULL,
	"data" "bytea" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_photos_content_type_valid" CHECK ("user_photos"."content_type" in ('image/jpeg', 'image/png', 'image/webp')),
	CONSTRAINT "user_photos_size" CHECK (octet_length("user_photos"."data") between 1 and 524288)
);
--> statement-breakpoint
ALTER TABLE "user_photos" ADD CONSTRAINT "user_photos_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_photos" ADD CONSTRAINT "user_photos_user_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "photo_url";