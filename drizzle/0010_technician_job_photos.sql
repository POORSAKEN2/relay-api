ALTER TABLE "job_photos" ADD COLUMN "content_type" text NOT NULL;--> statement-breakpoint
ALTER TABLE "job_photos" ADD COLUMN "data" "bytea" NOT NULL;--> statement-breakpoint
ALTER TABLE "job_photos" ADD CONSTRAINT "job_photos_content_type_valid" CHECK ("job_photos"."content_type" in ('image/jpeg', 'image/png', 'image/webp'));--> statement-breakpoint
ALTER TABLE "job_photos" ADD CONSTRAINT "job_photos_size" CHECK (octet_length("job_photos"."data") between 1 and 1048576);--> statement-breakpoint
ALTER TABLE "job_photos" DROP COLUMN "storage_key";
