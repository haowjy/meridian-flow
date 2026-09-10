ALTER TABLE "project_user_preferences" DROP CONSTRAINT "project_user_preferences_new_chat_fallback_work_id_works_id_fk";
--> statement-breakpoint
ALTER TABLE "project_user_preferences" DROP COLUMN "new_chat_fallback_work_id"; -- migration-lint: skip DROP_COLUMN (v3 has no user data; the obsolete fallback authority must be deleted)
