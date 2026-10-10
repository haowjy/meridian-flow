ALTER TABLE "document_branches" DROP CONSTRAINT "document_branches_owner_shape";--> statement-breakpoint
ALTER TABLE "document_branches" DROP CONSTRAINT "document_branches_work_id_works_id_fk";
--> statement-breakpoint
ALTER TABLE "document_branches" DROP CONSTRAINT "document_branches_deleted_by_work_id_works_id_fk";
--> statement-breakpoint
DROP INDEX "document_branches_active_work_draft_by_work";--> statement-breakpoint
DROP INDEX "document_branches_deleted_by_work_idx";--> statement-breakpoint
DROP INDEX "document_branches_active_work_draft";--> statement-breakpoint
ALTER TABLE "document_branches" ADD COLUMN "draft_id" uuid;--> statement-breakpoint
-- Branches key by draft (decision 3): a Work with branches and no active draft gets one.
INSERT INTO "drafts" ("project_id", "origin_work_id", "created_by")
SELECT w."project_id", w."id", coalesce(w."created_by_user_id", p."user_id")
FROM "works" w JOIN "projects" p ON p."id" = w."project_id"
WHERE EXISTS (SELECT 1 FROM "document_branches" b WHERE b."work_id" = w."id")
  AND NOT EXISTS (
    SELECT 1 FROM "drafts" d WHERE d."origin_work_id" = w."id" AND d."status" = 'active'
  );--> statement-breakpoint
UPDATE "document_branches" b SET "draft_id" = (
  SELECT d."id" FROM "drafts" d
  WHERE d."origin_work_id" = b."work_id" AND d."status" = 'active'
  ORDER BY d."created_at", d."id" LIMIT 1
) WHERE b."work_id" IS NOT NULL;--> statement-breakpoint
UPDATE "document_branches" b SET "draft_id" = u."draft_id"
FROM "document_branches" u
WHERE b."draft_id" IS NULL AND u."id" = b."upstream_branch_id";--> statement-breakpoint
-- A peer with neither a Work nor an upstream belongs to no draft; peers journal nothing.
DELETE FROM "document_branches" WHERE "draft_id" IS NULL;--> statement-breakpoint
ALTER TABLE "document_branches" ALTER COLUMN "draft_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "document_branches" ADD CONSTRAINT "document_branches_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_branches_active_work_draft_by_draft" ON "document_branches" USING btree ("draft_id","id","generation") WHERE "document_branches"."kind" = 'work_draft' AND "document_branches"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "document_branches_active_work_draft" ON "document_branches" USING btree ("document_id","draft_id") WHERE "document_branches"."kind" = 'work_draft' AND "document_branches"."status" = 'active';--> statement-breakpoint
ALTER TABLE "document_branches" DROP COLUMN "work_id";--> statement-breakpoint
ALTER TABLE "document_branches" DROP COLUMN "deleted_by_work_id";--> statement-breakpoint
ALTER TABLE "document_branches" ADD CONSTRAINT "document_branches_owner_shape" CHECK (("document_branches"."kind" = 'work_draft' AND "document_branches"."thread_id" IS NULL) OR ("document_branches"."kind" = 'thread_peer' AND "document_branches"."thread_id" IS NOT NULL));