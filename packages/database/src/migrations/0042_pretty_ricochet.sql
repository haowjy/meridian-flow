SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "inbox_blocked_reason" text;