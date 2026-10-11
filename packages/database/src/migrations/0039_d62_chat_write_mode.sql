-- D62: the chat owns its AI write mode. The Work's mode becomes the default a new chat copies, each
-- thread gets its own mode backfilled from its primary Work, and a thread control body may switch it.
-- The new CHECKs are added NOT VALID and validated by 0040.
SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
-- Metadata-only rename under the lock timeout; every reader is renamed in the same release.
ALTER TABLE "works" RENAME COLUMN "ai_write_mode" TO "default_ai_write_mode"; -- migration-lint: skip RENAME_COLUMN
--> statement-breakpoint
ALTER TABLE "works" RENAME CONSTRAINT "works_ai_write_mode_valid" TO "works_default_ai_write_mode_valid";
--> statement-breakpoint
-- A constant default makes this metadata-only on a populated table.
ALTER TABLE "threads" ADD COLUMN "ai_write_mode" text DEFAULT 'direct' NOT NULL;
--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_ai_write_mode_valid" CHECK ("threads"."ai_write_mode" IN ('direct', 'draft')) NOT VALID;
--> statement-breakpoint
-- Every thread, deleted and child threads included, starts in its primary Work's mode, so a restore
-- keeps it. A thread with no primary row keeps 'direct'.
UPDATE "threads" AS t SET "ai_write_mode" = w."default_ai_write_mode"
FROM "thread_works" AS tw
JOIN "works" AS w ON w."id" = tw."work_id"
WHERE tw."thread_id" = t."id" AND tw."is_primary" AND w."default_ai_write_mode" <> t."ai_write_mode";
--> statement-breakpoint
ALTER TABLE "thread_inbox_messages" DROP CONSTRAINT "thread_inbox_messages_body_valid";
--> statement-breakpoint
ALTER TABLE "thread_inbox_messages" ADD CONSTRAINT "thread_inbox_messages_body_valid" CHECK ((CASE WHEN "thread_inbox_messages"."intent" = 'control' THEN ("thread_inbox_messages"."body"->>'kind' = 'compact' OR ("thread_inbox_messages"."body"->>'kind' = 'write_mode' AND "thread_inbox_messages"."body"->>'mode' IN ('direct','draft'))) ELSE "thread_inbox_messages"."body"->>'kind' IN ('text','context','work_context_refresh') END) IS TRUE) NOT VALID;
