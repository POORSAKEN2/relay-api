ALTER TABLE "jobs" ADD COLUMN "booked_via" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_booked_via_valid" CHECK ("jobs"."booked_via" in ('google', 'widget'));