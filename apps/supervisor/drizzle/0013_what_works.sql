CREATE TABLE "sv_what_works" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"text" text NOT NULL,
	"facts" jsonb NOT NULL,
	"action_id" text,
	"via" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sv_post_metrics" ADD COLUMN "bookmarks" integer;--> statement-breakpoint
ALTER TABLE "sv_post_metrics" ADD COLUMN "profile_clicks" integer;--> statement-breakpoint
ALTER TABLE "sv_post_metrics" ADD COLUMN "link_clicks" integer;--> statement-breakpoint
ALTER TABLE "sv_post_metrics" ADD COLUMN "features" jsonb;--> statement-breakpoint
CREATE INDEX "sv_what_works_agent_created_idx" ON "sv_what_works" USING btree ("agent_id","created_at");