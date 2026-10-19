SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN "thread_id" uuid;
--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_thread_root_only" CHECK ("thread_id" IS NULL OR "parent_id" IS NULL) NOT VALID;
