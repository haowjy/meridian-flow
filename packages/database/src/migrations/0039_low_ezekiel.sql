SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
DROP TABLE "turn_trail_work";--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "trail_dirty_revision" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "trail_dirty_revision" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "change_trail_shells" ADD COLUMN "reconciled_revision" bigint DEFAULT 0 NOT NULL;