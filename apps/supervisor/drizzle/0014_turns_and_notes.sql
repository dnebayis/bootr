CREATE TABLE "sv_turns" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"role" text NOT NULL,
	"via" text,
	"wake_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	"thoughts" integer DEFAULT 0 NOT NULL,
	"outcome" text NOT NULL,
	"posted" integer DEFAULT 0 NOT NULL,
	"replied" integer DEFAULT 0 NOT NULL,
	"charged_micro_usdc" text DEFAULT '0' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sv_memories" ADD COLUMN "kind" text;--> statement-breakpoint
ALTER TABLE "sv_memories" ADD COLUMN "key" text;--> statement-breakpoint
ALTER TABLE "sv_memories" ADD COLUMN "updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sv_memories" ADD COLUMN "count" integer;--> statement-breakpoint
ALTER TABLE "sv_memories" ADD COLUMN "due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sv_memories" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "sv_turns_agent_started_idx" ON "sv_turns" USING btree ("agent_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sv_memories_agent_key_idx" ON "sv_memories" USING btree ("agent_id","kind","key") WHERE "sv_memories"."key" is not null;