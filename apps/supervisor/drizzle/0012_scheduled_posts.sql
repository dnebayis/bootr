CREATE TABLE "sv_scheduled_posts" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"action_id" text NOT NULL,
	"text" text NOT NULL,
	"text_hash" text NOT NULL,
	"thread" jsonb,
	"image_id" text,
	"topic" text,
	"via" text,
	"client_id" text,
	"send_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"error" text,
	"post_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"feedback_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "sv_scheduled_posts_due_idx" ON "sv_scheduled_posts" USING btree ("status","send_at");--> statement-breakpoint
CREATE INDEX "sv_scheduled_posts_agent_idx" ON "sv_scheduled_posts" USING btree ("agent_id","send_at");