-- Retire unused thread grouping and duplicated favorite IDs. No writer content
-- or auto-resume settings are removed. The timeout bounds the lock acquisition wait.
-- Transfer visible, project-owned pins to Favorites; invalid, deleted, foreign
-- and orphaned IDs are discarded. Existing favorites are never cleared.
SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
ALTER TABLE "project_user_preferences" DROP CONSTRAINT "project_user_preferences_thread_group_by_check";--> statement-breakpoint
ALTER TABLE "project_user_preferences" DROP COLUMN "thread_group_by";--> statement-breakpoint
INSERT INTO "thread_user_state" ("thread_id", "user_id", "is_favorite")
SELECT DISTINCT t.id, prefs.user_id, true
FROM project_user_preferences prefs
JOIN projects p ON p.id = prefs.project_id AND p.user_id = prefs.user_id
  AND p.deleted_at IS NULL
CROSS JOIN LATERAL unnest(prefs.pinned_thread_ids) AS pin(thread_id)
JOIN threads t ON t.id::text = lower(pin.thread_id) AND t.project_id = p.id
  AND t.deleted_at IS NULL AND t.created_by_user_id = prefs.user_id
ON CONFLICT (thread_id, user_id) DO UPDATE SET is_favorite = true;
--> statement-breakpoint
ALTER TABLE "project_user_preferences" DROP COLUMN "pinned_thread_ids";