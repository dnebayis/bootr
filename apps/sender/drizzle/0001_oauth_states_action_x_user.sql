CREATE TABLE "sender_oauth_states" (
	"nonce" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sender_actions" ADD COLUMN "x_user_id" text;--> statement-breakpoint
CREATE INDEX "sender_oauth_states_expires_idx" ON "sender_oauth_states" USING btree ("expires_at");