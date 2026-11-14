CREATE TABLE "sv_ds_records" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"entities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cluster" text NOT NULL,
	"weight" integer DEFAULT 1 NOT NULL,
	"coin" text,
	"headline" text NOT NULL,
	"summary" text,
	"link" text,
	"words" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_reinforced_at" timestamp with time zone NOT NULL,
	"observation_count" integer DEFAULT 1 NOT NULL,
	"event_time" timestamp with time zone,
	"event_end" timestamp with time zone,
	"event_precision" text DEFAULT 'unknown' NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"groups" integer DEFAULT 1 NOT NULL,
	"grade" integer DEFAULT 1 NOT NULL,
	"cited" boolean DEFAULT false NOT NULL,
	"numbers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"changed_at" timestamp with time zone,
	"changes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"posted" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"day" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sv_ds_sightings" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"record_id" text NOT NULL,
	"external_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"excerpt" text,
	"withheld" boolean DEFAULT false NOT NULL,
	"link" text,
	"link_key" text,
	"key" text,
	"refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"matched_by" text NOT NULL,
	"published_at" timestamp with time zone,
	"seen_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sv_ds_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"layer" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"url" text,
	"cluster" text NOT NULL,
	"group_id" text NOT NULL,
	"official_for" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"x_user_id" text,
	"x_handle" text,
	"tier" integer,
	"status" text DEFAULT 'active' NOT NULL,
	"status_reason" text,
	"etag" text,
	"last_modified" text,
	"content_hash" text,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_fetch_at" timestamp with time zone,
	"last_ok_at" timestamp with time zone,
	"next_fetch_at" timestamp with time zone,
	"last_status" integer,
	"failures" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "sv_ds_records_day_idx" ON "sv_ds_records" USING btree ("day","grade");--> statement-breakpoint
CREATE INDEX "sv_ds_records_reinforced_idx" ON "sv_ds_records" USING btree ("last_reinforced_at");--> statement-breakpoint
CREATE INDEX "sv_ds_records_coin_idx" ON "sv_ds_records" USING btree ("coin");--> statement-breakpoint
CREATE INDEX "sv_ds_sightings_record_idx" ON "sv_ds_sightings" USING btree ("record_id");--> statement-breakpoint
CREATE INDEX "sv_ds_sightings_link_idx" ON "sv_ds_sightings" USING btree ("link_key");--> statement-breakpoint
CREATE INDEX "sv_ds_sightings_key_idx" ON "sv_ds_sightings" USING btree ("key");--> statement-breakpoint
CREATE INDEX "sv_ds_sightings_seen_idx" ON "sv_ds_sightings" USING btree ("seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sv_ds_sources_x_user_idx" ON "sv_ds_sources" USING btree ("x_user_id");--> statement-breakpoint
CREATE INDEX "sv_ds_sources_due_idx" ON "sv_ds_sources" USING btree ("layer","status","next_fetch_at");