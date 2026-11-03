CREATE TABLE "sv_images" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"action_id" text NOT NULL,
	"alt" text NOT NULL,
	"mime" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"size_bytes" integer NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sv_images_action_id_unique" UNIQUE("action_id")
);
--> statement-breakpoint
CREATE INDEX "sv_images_agent_created_idx" ON "sv_images" USING btree ("agent_id","created_at");