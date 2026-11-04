CREATE TABLE "sv_post_metrics" (
	"post_id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"kind" text NOT NULL,
	"excerpt" text NOT NULL,
	"posted_at" timestamp with time zone NOT NULL,
	"measured_at" timestamp with time zone NOT NULL,
	"likes" integer DEFAULT 0 NOT NULL,
	"replies" integer DEFAULT 0 NOT NULL,
	"reposts" integer DEFAULT 0 NOT NULL,
	"quotes" integer DEFAULT 0 NOT NULL,
	"impressions" integer,
	"unavailable" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX "sv_post_metrics_agent_posted_idx" ON "sv_post_metrics" USING btree ("agent_id","posted_at");