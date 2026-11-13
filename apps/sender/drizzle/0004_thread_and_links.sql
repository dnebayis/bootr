ALTER TABLE "sender_actions" ADD COLUMN "thread_head" text;--> statement-breakpoint
ALTER TABLE "sender_actions" ADD COLUMN "thread_n" integer;--> statement-breakpoint
ALTER TABLE "sender_quotas" ADD COLUMN "link_posts_per_day" integer;