-- M-1 / M-2 / H-3: idempotency keys are namespaced per payer, one authorization funds one request,
-- and rows carry the payment proof hash and upstream attempt count.
-- Existing rows: the payer and nonce come from the stored payment; rows without one get placeholders
-- (they can never be matched by a real payer). The proof hash of old rows is unknown, so they can no
-- longer be read or replayed through the API (they are all terminal or reconciled by now).
UPDATE "inference_requests" SET "payer" = lower(coalesce("payer", "payment"->>'payer', "payment"->'authorization'->>'from', 'legacy:' || "request_id"));--> statement-breakpoint
ALTER TABLE "inference_requests" DROP CONSTRAINT "inference_requests_pkey";--> statement-breakpoint
ALTER TABLE "inference_requests" ALTER COLUMN "payer" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "inference_requests" ADD CONSTRAINT "inference_requests_payer_key_pk" PRIMARY KEY("payer","idempotency_key");--> statement-breakpoint
ALTER TABLE "inference_requests" ADD COLUMN "payment_nonce" text;--> statement-breakpoint
UPDATE "inference_requests" SET "payment_nonce" = lower(coalesce("payment"->'authorization'->>'nonce', 'legacy:' || "request_id"));--> statement-breakpoint
-- Rows that shared one authorization (the H-3b replay) keep only the first nonce; later ones get a
-- placeholder so the unique index can be created.
UPDATE "inference_requests" r SET "payment_nonce" = 'legacy-dup:' || r."request_id" WHERE EXISTS (SELECT 1 FROM "inference_requests" o WHERE o."payer" = r."payer" AND o."payment_nonce" = r."payment_nonce" AND o."created_at" < r."created_at");--> statement-breakpoint
ALTER TABLE "inference_requests" ALTER COLUMN "payment_nonce" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "inference_requests" ADD COLUMN "proof_hash" text;--> statement-breakpoint
UPDATE "inference_requests" SET "proof_hash" = 'legacy';--> statement-breakpoint
ALTER TABLE "inference_requests" ALTER COLUMN "proof_hash" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "inference_requests" ADD COLUMN "upstream_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "inference_requests_payer_nonce_idx" ON "inference_requests" USING btree ("payer","payment_nonce");
