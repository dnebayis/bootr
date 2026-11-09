CREATE TABLE "sv_bounty_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"reply_id" text NOT NULL,
	"author_id" text NOT NULL,
	"author_created_at" timestamp with time zone,
	"received_at" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"artefact" jsonb,
	"payee" text,
	"eligible" boolean DEFAULT false NOT NULL,
	"ineligible_reason" text,
	"considered" boolean DEFAULT false NOT NULL,
	"n" integer,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sv_bounty_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"action_id" text NOT NULL,
	"nonce" integer NOT NULL,
	"task" text NOT NULL,
	"criteria" jsonb NOT NULL,
	"deliverable" text NOT NULL,
	"amount_micro_usdc" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"opened_at" timestamp with time zone,
	"closes_at" timestamp with time zone NOT NULL,
	"publish_not_before" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"post_id" text,
	"conversation_id" text,
	"page_text" text NOT NULL,
	"verdict" jsonb,
	"judged_at" timestamp with time zone,
	"approval_id" text,
	"payee" text,
	"tx_hash" text,
	"paid_at" timestamp with time zone,
	"paid_reply_id" text,
	"close_reply_id" text,
	"entries_received" integer DEFAULT 0 NOT NULL,
	"entries_eligible" integer DEFAULT 0 NOT NULL,
	"entries_considered" integer DEFAULT 0 NOT NULL,
	"closed_at" timestamp with time zone,
	"error" text,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "sv_bounty_entries_job_idx" ON "sv_bounty_entries" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sv_bounty_entries_job_reply_idx" ON "sv_bounty_entries" USING btree ("job_id","reply_id");--> statement-breakpoint
CREATE INDEX "sv_bounty_jobs_agent_status_idx" ON "sv_bounty_jobs" USING btree ("agent_id","status");--> statement-breakpoint
CREATE INDEX "sv_bounty_jobs_agent_created_idx" ON "sv_bounty_jobs" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sv_bounty_jobs_action_idx" ON "sv_bounty_jobs" USING btree ("action_id");