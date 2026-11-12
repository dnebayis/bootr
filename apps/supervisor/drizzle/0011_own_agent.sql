CREATE TABLE "sv_agent_clients" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text,
	"draft_id" text,
	"creator" text NOT NULL,
	"token_hash" text NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sv_agent_grants" (
	"device_hash" text PRIMARY KEY NOT NULL,
	"user_code" text NOT NULL,
	"client_name" text NOT NULL,
	"coin_hint" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"agent_id" text,
	"draft_id" text,
	"creator" text,
	"label" text,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"approved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "sv_agent_clients_token_idx" ON "sv_agent_clients" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sv_agent_clients_agent_idx" ON "sv_agent_clients" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "sv_agent_clients_draft_idx" ON "sv_agent_clients" USING btree ("draft_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sv_agent_grants_user_code_idx" ON "sv_agent_grants" USING btree ("user_code");