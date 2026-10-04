CREATE TABLE "branding_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"content_type" text NOT NULL,
	"data" "bytea" NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "branding_assets_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "branding_assets_kind_valid" CHECK ("branding_assets"."kind" in ('logo', 'favicon')),
	CONSTRAINT "branding_assets_content_type_valid" CHECK ("branding_assets"."content_type" in ('image/png', 'image/svg+xml')),
	CONSTRAINT "branding_assets_size" CHECK (octet_length("branding_assets"."data") between 1 and 524288)
);
--> statement-breakpoint
ALTER TABLE "branding_versions" ADD COLUMN "logo_asset_id" uuid;--> statement-breakpoint
ALTER TABLE "branding_versions" ADD COLUMN "favicon_asset_id" uuid;--> statement-breakpoint
ALTER TABLE "branding_assets" ADD CONSTRAINT "branding_assets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branding_assets" ADD CONSTRAINT "branding_assets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branding_versions" ADD CONSTRAINT "branding_versions_logo_fk" FOREIGN KEY ("tenant_id","logo_asset_id") REFERENCES "public"."branding_assets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branding_versions" ADD CONSTRAINT "branding_versions_favicon_fk" FOREIGN KEY ("tenant_id","favicon_asset_id") REFERENCES "public"."branding_assets"("tenant_id","id") ON DELETE no action ON UPDATE no action;