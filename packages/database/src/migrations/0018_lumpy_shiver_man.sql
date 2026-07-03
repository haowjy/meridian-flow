ALTER TABLE "works" ADD COLUMN "ai_write_mode" text DEFAULT 'direct' NOT NULL;--> statement-breakpoint
UPDATE "works" w
SET "ai_write_mode" = COALESCE(p."ai_write_mode", 'direct')
FROM "project_user_preferences" p
WHERE p."project_id" = w."project_id";--> statement-breakpoint
ALTER TABLE "works" ADD CONSTRAINT "works_ai_write_mode_valid" CHECK ("works"."ai_write_mode" IN ('direct', 'draft'));--> statement-breakpoint
ALTER TABLE "document_yjs_drafts" ADD COLUMN "created_document" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "threads" DROP CONSTRAINT "threads_ai_write_mode_valid";--> statement-breakpoint
ALTER TABLE "threads" DROP COLUMN "ai_write_mode";--> statement-breakpoint
ALTER TABLE "project_user_preferences" DROP CONSTRAINT "project_user_preferences_ai_write_mode_check";--> statement-breakpoint
ALTER TABLE "project_user_preferences" DROP COLUMN "ai_write_mode";
