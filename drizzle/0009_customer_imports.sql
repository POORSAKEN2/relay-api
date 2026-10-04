CREATE TABLE "customer_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"file_name" text NOT NULL,
	"created_count" integer NOT NULL,
	"skipped_count" integer NOT NULL,
	"kept_count" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"undone_at" timestamp with time zone,
	CONSTRAINT "customer_imports_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "customer_imports_counts_not_negative" CHECK ("customer_imports"."created_count" >= 0 and "customer_imports"."skipped_count" >= 0 and ("customer_imports"."kept_count" is null or "customer_imports"."kept_count" >= 0)),
	CONSTRAINT "customer_imports_undo_complete" CHECK (("customer_imports"."undone_at" is null) = ("customer_imports"."kept_count" is null))
);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "import_id" uuid;--> statement-breakpoint
ALTER TABLE "customer_imports" ADD CONSTRAINT "customer_imports_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_imports" ADD CONSTRAINT "customer_imports_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_imports_tenant_created_idx" ON "customer_imports" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_import_fk" FOREIGN KEY ("tenant_id","import_id") REFERENCES "public"."customer_imports"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customers_tenant_import_idx" ON "customers" USING btree ("tenant_id","import_id");--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_import_has_source" CHECK ("customers"."import_id" is null or "customers"."source" = 'import');