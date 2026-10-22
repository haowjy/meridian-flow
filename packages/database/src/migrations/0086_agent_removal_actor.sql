-- A model's delete names its chat (PR 3's agent actor). Metadata only: the FK is NOT VALID and
-- the index is built concurrently, and both validate, in 0087.
SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "deleted_by_thread_id" uuid;
--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_deleted_by_thread_id_threads_id_fk" FOREIGN KEY ("deleted_by_thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action NOT VALID;
