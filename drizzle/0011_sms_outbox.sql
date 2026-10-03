ALTER TABLE "webhook_events" DROP CONSTRAINT "webhook_events_provider_valid";--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "send_after" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "attempts" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "last_error" text;--> statement-breakpoint
CREATE INDEX "messages_due_idx" ON "messages" USING btree ("send_after") WHERE "messages"."status" = 'queued' and "messages"."provider_message_id" is null;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_attempts_range" CHECK ("messages"."attempts" between 0 and 3);--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_inbound_no_attempts" CHECK ("messages"."direction" = 'outbound' or "messages"."attempts" = 0);--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_provider_valid" CHECK ("webhook_events"."provider" in ('twilio', 'xendit', 'stripe', 'httpsms'));