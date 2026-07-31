ALTER TABLE "works" RENAME COLUMN "title" TO "name";--> statement-breakpoint
ALTER TABLE "works" ALTER COLUMN "name" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "works" DROP CONSTRAINT "works_visibility_valid";--> statement-breakpoint
ALTER TABLE "works" DROP CONSTRAINT "works_persistence_valid";--> statement-breakpoint
ALTER TABLE "document_branches" ALTER COLUMN "schema_version" SET DEFAULT 4000;--> statement-breakpoint
ALTER TABLE "document_yjs_heads" ALTER COLUMN "schema_version" SET DEFAULT 4000;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "slug" text;--> statement-breakpoint
ALTER TABLE "works" ADD COLUMN "goal" text;--> statement-breakpoint
ALTER TABLE "works" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "works" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "works" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_user_preferences" ADD COLUMN "current_work_id" uuid;--> statement-breakpoint
ALTER TABLE "project_user_preferences" ADD CONSTRAINT "project_user_preferences_current_work_id_works_id_fk" FOREIGN KEY ("current_work_id") REFERENCES "public"."works"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "threads_project_slug_active" ON "threads" USING btree ("project_id","slug") WHERE "threads"."slug" IS NOT NULL AND "threads"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "works_project_name_active" ON "works" USING btree ("project_id",lower("name")) WHERE "works"."deleted_at" IS NULL;--> statement-breakpoint
ALTER TABLE "works" DROP COLUMN "visibility";--> statement-breakpoint
ALTER TABLE "works" DROP COLUMN "persistence";--> statement-breakpoint
ALTER TABLE "works" ADD CONSTRAINT "works_name_nonempty" CHECK (btrim("works"."name") <> '');--> statement-breakpoint
ALTER TABLE "works" ADD CONSTRAINT "works_status_valid" CHECK ("works"."status" IN ('active', 'archived'));
