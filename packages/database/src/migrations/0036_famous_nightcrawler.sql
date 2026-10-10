-- Retire unused thread grouping and duplicated favorite IDs. No writer content
-- or auto-resume settings are removed. Bound the metadata-only table lock.
SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
ALTER TABLE "project_user_preferences" DROP CONSTRAINT "project_user_preferences_thread_group_by_check";--> statement-breakpoint
ALTER TABLE "project_user_preferences" DROP COLUMN "thread_group_by";--> statement-breakpoint
ALTER TABLE "project_user_preferences" DROP COLUMN "pinned_thread_ids";