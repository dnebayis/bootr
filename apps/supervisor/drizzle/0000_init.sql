CREATE TABLE "sv_actions" (
	"action_id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"cycle_key" text NOT NULL,
	"action" jsonb NOT NULL,
	"status" text NOT NULL,
	"result" jsonb,
	"receipt" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sv_agents" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"kernel" text NOT NULL,
	"creator" text NOT NULL,
	"config" jsonb NOT NULL,
	"permission_id" text,
	"validator_data" text,
	"session_policy" jsonb,
	"session_valid_until" timestamp with time zone,
	"session_key_installed_at" timestamp with time zone,
	"launch_block" integer,
	"launch_tx_hash" text,
	"status" text DEFAULT 'onboarding' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sv_agents_kernel_unique" UNIQUE("kernel")
);
--> statement-breakpoint
CREATE TABLE "sv_cursors" (
	"name" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sv_inference" (
	"idempotency_key" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"cycle" integer NOT NULL,
	"request_hash" text NOT NULL,
	"request" jsonb NOT NULL,
	"status" text NOT NULL,
	"response" jsonb,
	"receipt" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sv_memories" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"text" text NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"supersedes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sv_runtimes" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"state" jsonb NOT NULL,
	"cycle" integer DEFAULT 0 NOT NULL,
	"lease_token" text,
	"lease_until" timestamp with time zone,
	"pending" jsonb,
	"turn" jsonb,
	"next_at" timestamp with time zone NOT NULL,
	"last_decision_at" timestamp with time zone,
	"last_decision_revision" integer,
	"config_revision" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"paused_by" text,
	"failures" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sv_treasury_ops" (
	"op_id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"kind" text NOT NULL,
	"calls" jsonb NOT NULL,
	"call_hash" text NOT NULL,
	"description" text NOT NULL,
	"origin" text NOT NULL,
	"user_op_hash" text,
	"tx_hash" text,
	"status" text DEFAULT 'prepared' NOT NULL,
	"error" text,
	"sent_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "sv_actions_agent_created_idx" ON "sv_actions" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "sv_inference_agent_idx" ON "sv_inference" USING btree ("agent_id","status");--> statement-breakpoint
CREATE INDEX "sv_memories_agent_idx" ON "sv_memories" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "sv_runtimes_next_at_idx" ON "sv_runtimes" USING btree ("status","next_at");--> statement-breakpoint
CREATE INDEX "sv_treasury_ops_agent_idx" ON "sv_treasury_ops" USING btree ("agent_id","status");