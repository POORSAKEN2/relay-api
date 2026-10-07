ALTER TABLE "waitlist_entries" DROP CONSTRAINT "waitlist_entries_status_valid";--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD COLUMN "ends_at" timestamp with time zone DEFAULT now() + interval '14 days' NOT NULL;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD COLUMN "offer_window_id" uuid;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD COLUMN "offer_date" date;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD COLUMN "offer_window_starts_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD COLUMN "offer_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD COLUMN "offer_link_hash" text;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD COLUMN "offers_missed" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD COLUMN "missed_window_starts_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "waitlist_entries_offered_idx" ON "waitlist_entries" USING btree ("tenant_id","offer_window_starts_at") WHERE "waitlist_entries"."status" = 'offered';--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_offer_link_hash_unique" UNIQUE("offer_link_hash");--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_offer_complete" CHECK (("waitlist_entries"."status" = 'offered') = ("waitlist_entries"."offer_window_id" is not null and "waitlist_entries"."offer_date" is not null and "waitlist_entries"."offer_window_starts_at" is not null and "waitlist_entries"."offer_expires_at" is not null and "waitlist_entries"."offer_link_hash" is not null));--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_offers_missed_range" CHECK ("waitlist_entries"."offers_missed" between 0 and 2);--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_status_valid" CHECK ("waitlist_entries"."status" in ('waiting', 'offered', 'booked', 'removed', 'expired'));