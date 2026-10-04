ALTER TABLE "webhook_events" DROP CONSTRAINT "webhook_events_provider_valid";--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "subscription_status" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "subscription_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "subscription_event_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_subscription_status_valid" CHECK ("tenants"."subscription_status" in ('none', 'active', 'billing_issue', 'expired'));--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_provider_valid" CHECK ("webhook_events"."provider" in ('twilio', 'xendit', 'stripe', 'httpsms', 'revenuecat'));