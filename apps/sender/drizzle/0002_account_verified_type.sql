ALTER TABLE "sender_accounts" ADD COLUMN "verified_type" text;--> statement-breakpoint
ALTER TABLE "sender_accounts" ADD COLUMN "verified_checked_at" timestamp with time zone;