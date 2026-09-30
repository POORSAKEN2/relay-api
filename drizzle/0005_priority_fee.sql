ALTER TABLE "jobs" ADD COLUMN "priority_fee_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "priority_fee_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_priority_fee_not_negative" CHECK ("jobs"."priority_fee_cents" >= 0);--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_priority_fee_needs_priority" CHECK ("jobs"."priority_fee_cents" = 0 or "jobs"."priority");--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_priority_fee_not_negative" CHECK ("tenants"."priority_fee_cents" >= 0);