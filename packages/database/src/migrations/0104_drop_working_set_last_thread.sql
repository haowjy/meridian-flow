ALTER TABLE "project_user_working_sets" DROP CONSTRAINT "project_user_working_sets_last_thread_id_threads_id_fk";
--> statement-breakpoint
ALTER TABLE "project_user_working_sets" DROP COLUMN "last_thread_id";