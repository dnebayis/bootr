CREATE TABLE "sender_dataset_users" (
	"user_id" text PRIMARY KEY NOT NULL,
	"handle" text NOT NULL,
	"admitted_at" timestamp with time zone DEFAULT now() NOT NULL
);
