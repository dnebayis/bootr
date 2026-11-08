CREATE TABLE "sv_service_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"url" text NOT NULL,
	"host" text NOT NULL,
	"method" text NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"cap_micro_usdc" text NOT NULL,
	"quote_micro_usdc" text,
	"charged_micro_usdc" text,
	"payment" jsonb,
	"pay_to" text,
	"tx_hash" text,
	"http_status" integer,
	"result" jsonb,
	"error" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "sv_service_calls_agent_created_idx" ON "sv_service_calls" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "sv_service_calls_agent_status_idx" ON "sv_service_calls" USING btree ("agent_id","status");