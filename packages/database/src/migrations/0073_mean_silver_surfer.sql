ALTER TABLE "project_user_preferences" RENAME COLUMN "current_work_id" TO "new_chat_fallback_work_id";--> statement-breakpoint
ALTER TABLE "project_user_preferences" DROP CONSTRAINT "project_user_preferences_current_work_id_works_id_fk";
--> statement-breakpoint
ALTER TABLE "project_user_preferences" ADD CONSTRAINT "project_user_preferences_new_chat_fallback_work_id_works_id_fk" FOREIGN KEY ("new_chat_fallback_work_id") REFERENCES "public"."works"("id") ON DELETE set null ON UPDATE no action;