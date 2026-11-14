CREATE TABLE "sv_gate_shadow" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"gate" text NOT NULL,
	"code" text NOT NULL,
	"action_id" text,
	"text_hash" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enforced" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sv_said" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"action_id" text NOT NULL,
	"post_id" text,
	"kind" text NOT NULL,
	"posted_at" timestamp with time zone NOT NULL,
	"fingerprints" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"facts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"opener" text DEFAULT '' NOT NULL,
	"words" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"record_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "sv_gate_shadow_agent_created_idx" ON "sv_gate_shadow" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "sv_gate_shadow_gate_created_idx" ON "sv_gate_shadow" USING btree ("gate","created_at");--> statement-breakpoint
CREATE INDEX "sv_said_agent_posted_idx" ON "sv_said" USING btree ("agent_id","posted_at");--> statement-breakpoint
CREATE INDEX "sv_said_posted_idx" ON "sv_said" USING btree ("posted_at");