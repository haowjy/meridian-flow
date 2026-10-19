SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
ALTER TABLE "folders" VALIDATE CONSTRAINT "folders_thread_root_only";
