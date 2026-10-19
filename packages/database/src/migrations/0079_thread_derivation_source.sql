SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "derivation_source_thread_id" uuid;
