CREATE TABLE "sv_chat_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"role" text NOT NULL,
	"text" text NOT NULL,
	"status" text DEFAULT 'done' NOT NULL,
	"inference_key" text,
	"charged_micro_usdc" text,
	"memory_id" text,
	"error" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sv_notification_settings" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"opt_out" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"checked_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sv_notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"event" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"first_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"last_sent_at" timestamp with time zone,
	"send_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sv_telegram_link_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"creator" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sv_telegram_links" (
	"creator" text PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"linked_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "sv_chat_messages_agent_idx" ON "sv_chat_messages" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sv_chat_messages_open_idx" ON "sv_chat_messages" USING btree ("agent_id") WHERE "sv_chat_messages"."status" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "sv_notifications_open_idx" ON "sv_notifications" USING btree ("agent_id","event") WHERE "sv_notifications"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "sv_notifications_agent_idx" ON "sv_notifications" USING btree ("agent_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "sv_telegram_links_chat_idx" ON "sv_telegram_links" USING btree ("chat_id");