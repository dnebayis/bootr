CREATE TABLE "sv_records_served" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"record_id" text NOT NULL,
	"first_served_at" timestamp with time zone NOT NULL,
	"last_served_at" timestamp with time zone NOT NULL,
	"times" integer DEFAULT 1 NOT NULL,
	"offered" integer DEFAULT 0 NOT NULL,
	"cited_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "sv_scheduled_posts" ADD COLUMN "record_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX "sv_records_served_agent_idx" ON "sv_records_served" USING btree ("agent_id","last_served_at");