CREATE TABLE "sv_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"text_hash" text NOT NULL,
	"image_id" text,
	"in_reply_to" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending_approval' NOT NULL,
	"decision" text,
	"decided_by" text,
	"note" text,
	"post_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"feedback_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "sv_approvals_agent_status_idx" ON "sv_approvals" USING btree ("agent_id","status");--> statement-breakpoint
CREATE INDEX "sv_approvals_agent_created_idx" ON "sv_approvals" USING btree ("agent_id","created_at");