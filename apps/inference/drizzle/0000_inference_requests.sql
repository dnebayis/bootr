CREATE TABLE "inference_requests" (
	"idempotency_key" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" text NOT NULL,
	"status_reason" text,
	"model" text NOT NULL,
	"quote_micro_usdc" bigint NOT NULL,
	"charged_micro_usdc" bigint,
	"payer" text,
	"payment" jsonb,
	"response" jsonb,
	"usage" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inference_requests_request_id_unique" UNIQUE("request_id")
);
--> statement-breakpoint
CREATE INDEX "inference_requests_status_updated_idx" ON "inference_requests" USING btree ("status","updated_at");