-- Technicians created before this migration have no address or emergency contact, so the
-- technician-profile check is added NOT VALID: it applies to new and updated rows only.
-- Once every technician is filled in, run: ALTER TABLE "users" VALIDATE CONSTRAINT "users_technician_profile";
-- Drizzle does not model NOT VALID, so this migration is edited by hand.
ALTER TABLE "users" ADD COLUMN "photo_url" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "address" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "emergency_contact_name" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "emergency_contact_phone" text;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_emergency_contact_phone_e164" CHECK ("users"."emergency_contact_phone" ~ '^\+[1-9][0-9]{7,14}$');--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_technician_profile" CHECK ("users"."role" <> 'technician' or ("users"."address" is not null and "users"."emergency_contact_name" is not null and "users"."emergency_contact_phone" is not null))
  NOT VALID;
