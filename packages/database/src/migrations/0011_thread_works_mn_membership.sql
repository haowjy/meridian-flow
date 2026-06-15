/*
 * A0: M:N thread↔work membership join, Work persistence column, manuscript scope work→project.
 * Backfills thread_works from threads.work_id before dropping the N:1 column.
 */
ALTER TABLE "works" ADD COLUMN "persistence" text DEFAULT 'persisted' NOT NULL;--> statement-breakpoint
ALTER TABLE "works" ADD CONSTRAINT "works_persistence_valid" CHECK ("persistence" IN ('persisted', 'ephemeral'));--> statement-breakpoint
ALTER TABLE "works" ADD CONSTRAINT "works_project_id_unique" UNIQUE("project_id","id");--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_project_id_unique" UNIQUE("project_id","id");--> statement-breakpoint
CREATE TABLE "thread_works" (
	"thread_id" uuid NOT NULL,
	"work_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"is_primary" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_works_pk" PRIMARY KEY("thread_id","work_id")
);--> statement-breakpoint
INSERT INTO "thread_works" ("thread_id", "work_id", "project_id", "is_primary", "created_at")
SELECT "id", "work_id", "project_id", true, now()
FROM "threads"
WHERE "work_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "thread_works" ADD CONSTRAINT "thread_works_project_thread_same_project_fk" FOREIGN KEY ("project_id","thread_id") REFERENCES "public"."threads"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_works" ADD CONSTRAINT "thread_works_project_work_same_project_fk" FOREIGN KEY ("project_id","work_id") REFERENCES "public"."works"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "thread_works_thread_idx" ON "thread_works" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "thread_works_work_idx" ON "thread_works" USING btree ("work_id");--> statement-breakpoint
CREATE UNIQUE INDEX "thread_works_primary_unique" ON "thread_works" USING btree ("thread_id") WHERE "thread_works"."is_primary" = true;--> statement-breakpoint
UPDATE "context_sources"
SET "project_id" = "works"."project_id", "work_id" = NULL, "scope" = 'project'
FROM "works"
WHERE "context_sources"."work_id" = "works"."id"
  AND "context_sources"."slug" = 'manuscript'
  AND "context_sources"."scope" = 'work';--> statement-breakpoint
ALTER TABLE "threads" DROP CONSTRAINT "threads_work_id_works_id_fk";--> statement-breakpoint
DROP INDEX "threads_work_updated_active";--> statement-breakpoint
ALTER TABLE "threads" DROP COLUMN "work_id";
