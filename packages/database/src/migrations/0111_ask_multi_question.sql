SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
ALTER TABLE "asks" ADD COLUMN "opened_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "asks" ADD COLUMN "draft_answers" jsonb;
