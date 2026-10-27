CREATE TABLE "sender_accounts" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"x_user_id" text NOT NULL,
	"x_handle" text NOT NULL,
	"encrypted_access_token" text NOT NULL,
	"encrypted_refresh_token" text,
	"scopes" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sender_actions" (
	"action_id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"reply_to" text,
	"reply_author_id" text,
	"body_hash" text NOT NULL,
	"status" text NOT NULL,
	"provider_post_id" text,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"checks" integer DEFAULT 0 NOT NULL,
	"next_check_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sender_inbox" (
	"agent_id" text NOT NULL,
	"post_id" text NOT NULL,
	"author_id" text NOT NULL,
	"conversation_id" text,
	"post" jsonb NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"deferred_until" timestamp with time zone,
	"seen_at" timestamp with time zone,
	"reply_id" text,
	CONSTRAINT "sender_inbox_agent_id_post_id_pk" PRIMARY KEY("agent_id","post_id")
);
--> statement-breakpoint
CREATE TABLE "sender_optouts" (
	"agent_id" text NOT NULL,
	"author_id" text NOT NULL,
	"enabled" boolean NOT NULL,
	"post_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sender_optouts_agent_id_author_id_pk" PRIMARY KEY("agent_id","author_id")
);
--> statement-breakpoint
CREATE TABLE "sender_quotas" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"posts_per_day" integer,
	"mention_read_interval_sec" integer,
	"last_mentions_read_at" timestamp with time zone,
	"mentions_since_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sender_reads" (
	"agent_id" text NOT NULL,
	"kind" text NOT NULL,
	"day" date NOT NULL,
	"count" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "sender_reads_agent_id_kind_day_pk" PRIMARY KEY("agent_id","kind","day")
);
--> statement-breakpoint
CREATE INDEX "sender_actions_agent_created_idx" ON "sender_actions" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "sender_actions_status_next_check_idx" ON "sender_actions" USING btree ("status","next_check_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sender_actions_provider_post_idx" ON "sender_actions" USING btree ("provider_post_id");--> statement-breakpoint
CREATE INDEX "sender_inbox_agent_status_idx" ON "sender_inbox" USING btree ("agent_id","status");