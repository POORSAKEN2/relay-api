CREATE TABLE "site_faqs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"question" text NOT NULL,
	"answer" text NOT NULL,
	"sort_order" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_faqs_question_length" CHECK (char_length("site_faqs"."question") between 1 and 200),
	CONSTRAINT "site_faqs_answer_length" CHECK (char_length("site_faqs"."answer") between 1 and 1000)
);
--> statement-breakpoint
CREATE TABLE "site_photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"content_type" text NOT NULL,
	"data" "bytea" NOT NULL,
	"alt_text" text NOT NULL,
	"sort_order" smallint DEFAULT 0 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_photos_kind_valid" CHECK ("site_photos"."kind" in ('hero', 'work')),
	CONSTRAINT "site_photos_content_type_valid" CHECK ("site_photos"."content_type" in ('image/jpeg', 'image/webp')),
	CONSTRAINT "site_photos_size" CHECK (octet_length("site_photos"."data") between 1 and 1048576),
	CONSTRAINT "site_photos_alt_text_length" CHECK (char_length("site_photos"."alt_text") between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "site_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"author_name" text NOT NULL,
	"place" text,
	"rating" smallint NOT NULL,
	"body" text NOT NULL,
	"sort_order" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_reviews_author_name_length" CHECK (char_length("site_reviews"."author_name") between 1 and 60),
	CONSTRAINT "site_reviews_place_length" CHECK (char_length("site_reviews"."place") <= 60),
	CONSTRAINT "site_reviews_rating_range" CHECK ("site_reviews"."rating" between 1 and 5),
	CONSTRAINT "site_reviews_body_length" CHECK (char_length("site_reviews"."body") between 1 and 600)
);
--> statement-breakpoint
CREATE TABLE "sites" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"design" text DEFAULT 'breeze' NOT NULL,
	"published_at" timestamp with time zone,
	"headline" text NOT NULL,
	"intro" text NOT NULL,
	"about" text,
	"license_number" text,
	"city" text NOT NULL,
	"region" text NOT NULL,
	"cities_served" text[] DEFAULT '{}' NOT NULL,
	"emergency_service" boolean DEFAULT false NOT NULL,
	"show_prices" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sites_design_valid" CHECK ("sites"."design" in ('breeze', 'clean', 'bold')),
	CONSTRAINT "sites_headline_length" CHECK (char_length("sites"."headline") between 1 and 120),
	CONSTRAINT "sites_intro_length" CHECK (char_length("sites"."intro") between 1 and 400),
	CONSTRAINT "sites_about_length" CHECK (char_length("sites"."about") <= 2000),
	CONSTRAINT "sites_license_number_length" CHECK (char_length("sites"."license_number") <= 60),
	CONSTRAINT "sites_city_length" CHECK (char_length("sites"."city") between 1 and 80),
	CONSTRAINT "sites_region_format" CHECK ("sites"."region" ~ '^[A-Z]{2}$'),
	CONSTRAINT "sites_cities_served_count" CHECK (cardinality("sites"."cities_served") <= 30)
);
--> statement-breakpoint
ALTER TABLE "site_faqs" ADD CONSTRAINT "site_faqs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_photos" ADD CONSTRAINT "site_photos_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_photos" ADD CONSTRAINT "site_photos_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_reviews" ADD CONSTRAINT "site_reviews_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "site_faqs_tenant_idx" ON "site_faqs" USING btree ("tenant_id","sort_order");--> statement-breakpoint
CREATE INDEX "site_photos_tenant_idx" ON "site_photos" USING btree ("tenant_id","kind","sort_order");--> statement-breakpoint
CREATE INDEX "site_reviews_tenant_idx" ON "site_reviews" USING btree ("tenant_id","sort_order");