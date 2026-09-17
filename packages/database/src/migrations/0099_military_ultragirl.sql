ALTER TABLE "works" DROP CONSTRAINT "works_slug_valid";--> statement-breakpoint
DROP INDEX "works_project_slug";--> statement-breakpoint
ALTER TABLE "works" ALTER COLUMN "slug" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "works" ADD COLUMN "is_no_work" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "works"
SET "name" = 'No Work (named)', "updated_at" = now()
WHERE "deleted_at" IS NULL
  AND lower(btrim("name")) = 'no work';--> statement-breakpoint
INSERT INTO "works" (
  "project_id",
  "created_by_user_id",
  "name",
  "slug",
  "is_no_work",
  "status",
  "ai_write_mode"
)
SELECT
  "projects"."id",
  "projects"."user_id",
  'No Work',
  NULL,
  true,
  'active',
  'direct'
FROM "projects"
WHERE "projects"."deleted_at" IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "works"
    WHERE "works"."project_id" = "projects"."id"
      AND "works"."is_no_work"
      AND "works"."deleted_at" IS NULL
  );--> statement-breakpoint
UPDATE "context_sources" AS "unlabeled"
SET
  "work_id" = "no_work"."id",
  "project_id" = NULL,
  "scope" = 'work',
  "updated_at" = now()
FROM "works" AS "no_work"
WHERE "no_work"."project_id" = "unlabeled"."project_id"
  AND "no_work"."is_no_work"
  AND "no_work"."deleted_at" IS NULL
  AND "unlabeled"."work_id" IS NULL
  AND "unlabeled"."slug" IN ('scratch', 'uploads')
  AND "unlabeled"."deleted_at" IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "context_sources" AS "existing"
    WHERE "existing"."work_id" = "no_work"."id"
      AND "existing"."slug" = "unlabeled"."slug"
      AND "existing"."deleted_at" IS NULL
  );--> statement-breakpoint
UPDATE "folders" AS "folder"
SET
  "context_source_id" = "existing"."id",
  "updated_at" = now()
FROM "context_sources" AS "unlabeled"
INNER JOIN "works" AS "no_work"
  ON "no_work"."project_id" = "unlabeled"."project_id"
  AND "no_work"."is_no_work"
  AND "no_work"."deleted_at" IS NULL
INNER JOIN "context_sources" AS "existing"
  ON "existing"."work_id" = "no_work"."id"
  AND "existing"."slug" = "unlabeled"."slug"
  AND "existing"."deleted_at" IS NULL
WHERE "folder"."context_source_id" = "unlabeled"."id"
  AND "unlabeled"."work_id" IS NULL
  AND "unlabeled"."slug" IN ('scratch', 'uploads')
  AND "unlabeled"."deleted_at" IS NULL;--> statement-breakpoint
UPDATE "documents" AS "document"
SET
  "context_source_id" = "existing"."id",
  "updated_at" = now()
FROM "context_sources" AS "unlabeled"
INNER JOIN "works" AS "no_work"
  ON "no_work"."project_id" = "unlabeled"."project_id"
  AND "no_work"."is_no_work"
  AND "no_work"."deleted_at" IS NULL
INNER JOIN "context_sources" AS "existing"
  ON "existing"."work_id" = "no_work"."id"
  AND "existing"."slug" = "unlabeled"."slug"
  AND "existing"."deleted_at" IS NULL
WHERE "document"."context_source_id" = "unlabeled"."id"
  AND "unlabeled"."work_id" IS NULL
  AND "unlabeled"."slug" IN ('scratch', 'uploads')
  AND "unlabeled"."deleted_at" IS NULL;--> statement-breakpoint
UPDATE "document_previous_locations" AS "previous"
SET "context_source_id" = "existing"."id"
FROM "context_sources" AS "unlabeled"
INNER JOIN "works" AS "no_work"
  ON "no_work"."project_id" = "unlabeled"."project_id"
  AND "no_work"."is_no_work"
  AND "no_work"."deleted_at" IS NULL
INNER JOIN "context_sources" AS "existing"
  ON "existing"."work_id" = "no_work"."id"
  AND "existing"."slug" = "unlabeled"."slug"
  AND "existing"."deleted_at" IS NULL
WHERE "previous"."context_source_id" = "unlabeled"."id"
  AND "unlabeled"."work_id" IS NULL
  AND "unlabeled"."slug" IN ('scratch', 'uploads')
  AND "unlabeled"."deleted_at" IS NULL;--> statement-breakpoint
UPDATE "upload_intakes" AS "intake"
SET
  "context_source_id" = "existing"."id",
  "work_id" = "no_work"."id",
  "updated_at" = now()
FROM "context_sources" AS "unlabeled"
INNER JOIN "works" AS "no_work"
  ON "no_work"."project_id" = "unlabeled"."project_id"
  AND "no_work"."is_no_work"
  AND "no_work"."deleted_at" IS NULL
INNER JOIN "context_sources" AS "existing"
  ON "existing"."work_id" = "no_work"."id"
  AND "existing"."slug" = "unlabeled"."slug"
  AND "existing"."deleted_at" IS NULL
WHERE "intake"."context_source_id" = "unlabeled"."id"
  AND "unlabeled"."work_id" IS NULL
  AND "unlabeled"."slug" IN ('scratch', 'uploads')
  AND "unlabeled"."deleted_at" IS NULL;--> statement-breakpoint
DELETE FROM "context_sources" AS "unlabeled"
USING "works" AS "no_work", "context_sources" AS "existing"
WHERE "unlabeled"."work_id" IS NULL
  AND "unlabeled"."slug" IN ('scratch', 'uploads')
  AND "unlabeled"."deleted_at" IS NULL
  AND "no_work"."project_id" = "unlabeled"."project_id"
  AND "no_work"."is_no_work"
  AND "no_work"."deleted_at" IS NULL
  AND "existing"."work_id" = "no_work"."id"
  AND "existing"."slug" = "unlabeled"."slug"
  AND "existing"."deleted_at" IS NULL;--> statement-breakpoint
INSERT INTO "thread_works" ("thread_id", "work_id", "project_id", "is_primary")
SELECT
  "threads"."id",
  "no_work"."id",
  "threads"."project_id",
  true
FROM "threads"
INNER JOIN "works" AS "no_work"
  ON "no_work"."project_id" = "threads"."project_id"
  AND "no_work"."is_no_work"
  AND "no_work"."deleted_at" IS NULL
WHERE "threads"."deleted_at" IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "thread_works"
    WHERE "thread_works"."thread_id" = "threads"."id"
      AND "thread_works"."is_primary"
  );--> statement-breakpoint
CREATE UNIQUE INDEX "works_project_no_work_active" ON "works" USING btree ("project_id") WHERE "works"."is_no_work" = true AND "works"."deleted_at" IS NULL; -- migration-lint: skip INDEX_NOT_CONCURRENTLY (pre-release; one locked No Work row is inserted above)--> statement-breakpoint
CREATE UNIQUE INDEX "works_project_slug" ON "works" USING btree ("project_id","slug") WHERE "works"."slug" IS NOT NULL; -- migration-lint: skip INDEX_NOT_CONCURRENTLY (pre-release; named slugs stay unique after No Work nulls)--> statement-breakpoint
ALTER TABLE "works" ADD CONSTRAINT "works_no_work_slug" CHECK (("works"."is_no_work" AND "works"."slug" IS NULL) OR (NOT "works"."is_no_work" AND "works"."slug" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "works" ADD CONSTRAINT "works_no_work_active" CHECK (NOT "works"."is_no_work" OR "works"."status" = 'active');--> statement-breakpoint
ALTER TABLE "works" ADD CONSTRAINT "works_slug_valid" CHECK ("works"."slug" IS NULL OR "works"."slug" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$');
