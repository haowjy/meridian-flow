-- migration: no-transaction
-- REQUIRES ALL WRITERS STOPPED (old and new release): the old release reads and writes a No Work
-- chat's drafts on the project's one No Work branch and keeps works.pending_document_count by
-- itself; the new one owns a branch by lineage (branches.origin_root_thread_id) and counts per
-- branch, so either release misreads the other's rows while both run. See
-- packages/database/.context/CONTEXT.md.
-- Precheck, run by hand on a copy before the real run: every row below must be a No Work branch
-- or closed; anything else is an owner this migration does not know how to move.
--   SELECT count(*) FROM branches b WHERE b.status = 'active' AND b.origin_work_id IS NULL;  -- 0
-- A chat with no Work owns its drafts per conversation lineage (the first chat, its forks and
-- subagents). Each active No Work branch is closed when it has nothing pending, moved to its
-- lineage when every recorded author sits in one lineage, and otherwise left on the No Work row
-- (the legacy branch: still reviewable and discardable, no new writes). Only owner columns and
-- counts change (and the unused branch_commands.work_id goes); no draft, journal or tree row
-- is rewritten.
BEGIN;
SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
ALTER TABLE "branch_commands" DROP COLUMN IF EXISTS "work_id";
--> statement-breakpoint
ALTER TABLE "branches" ADD COLUMN IF NOT EXISTS "origin_root_thread_id" uuid;
--> statement-breakpoint
ALTER TABLE "branches" ADD COLUMN IF NOT EXISTS "pending_document_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'branches'::regclass AND conname = 'branches_one_owner') THEN
    ALTER TABLE "branches" ADD CONSTRAINT "branches_one_owner" CHECK (num_nonnulls("branches"."origin_work_id", "branches"."origin_root_thread_id") <= 1 AND ("branches"."status" = 'closed' OR num_nonnulls("branches"."origin_work_id", "branches"."origin_root_thread_id") = 1)) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
-- The reviewable-pending predicate (tree-view-sql.ts `pendingIn`) as of this release, over every
-- active branch.
CREATE TEMP TABLE _lineage_pending ON COMMIT DROP AS
SELECT DISTINCT candidate.branch_id, candidate.document_id FROM (
    SELECT c.branch_id, c.node_id AS document_id FROM branch_tree_changes c
    WHERE c.node_kind = 'document'
      AND c.branch_id IN (SELECT id FROM branches WHERE status = 'active')
    UNION
    SELECT dd.branch_id, dd.document_id FROM document_drafts dd
    WHERE dd.kind = 'work_draft' AND dd.status = 'active' AND dd.has_effect
      AND dd.branch_id IN (SELECT id FROM branches WHERE status = 'active')
  ) candidate
  JOIN documents d ON d.id = candidate.document_id
  WHERE (EXISTS (SELECT 1 FROM branch_tree_changes c
      WHERE c.branch_id = candidate.branch_id AND c.node_kind = 'document' AND c.node_id = d.id AND (
        (c.deleted AND d.deleted_at IS NULL AND NOT d.hidden)
        OR (c.moved AND NOT c.deleted AND (
          (d.deleted_at IS NULL AND NOT d.hidden AND NOT (c.moved_folder_id IS NOT DISTINCT FROM d.folder_id
            AND (c.moved_folder_id IS NOT NULL OR c.moved_root_source_id = d.context_source_id)
            AND c.moved_name = d.name AND c.moved_extension = d.extension
            AND c.moved_rank IS NOT DISTINCT FROM d.rank))
          OR (d.deleted_at IS NULL AND d.hidden AND c.created)
          OR (d.deleted_at IS NOT NULL AND NOT d.hidden AND d.deletion_reason = 'deleted'
            AND d.deleted_by_work_id IS NULL)))
        OR (c.created AND NOT c.moved AND NOT c.deleted AND d.deleted_at IS NULL)))
    OR (EXISTS (SELECT 1 FROM document_drafts dd
        WHERE dd.document_id = d.id AND dd.branch_id = candidate.branch_id
          AND dd.kind = 'work_draft' AND dd.status = 'active' AND dd.has_effect)
      AND NOT EXISTS (SELECT 1 FROM branch_tree_changes x
        WHERE x.branch_id = candidate.branch_id AND x.node_kind = 'document' AND x.node_id = d.id
          AND x.deleted)));
--> statement-breakpoint
-- Close a No Work branch with nothing pending, no active draft and no tree row.
UPDATE "branches" b SET "status" = 'closed', "closed_at" = now()
WHERE b."status" = 'active'
  AND b."origin_work_id" IN (SELECT w."id" FROM "works" w WHERE w."is_no_work")
  AND NOT EXISTS (SELECT 1 FROM _lineage_pending p WHERE p.branch_id = b."id")
  AND NOT EXISTS (SELECT 1 FROM "document_drafts" dd
    WHERE dd."branch_id" = b."id" AND dd."kind" = 'work_draft' AND dd."status" = 'active')
  AND NOT EXISTS (SELECT 1 FROM "branch_tree_changes" c WHERE c."branch_id" = b."id");
--> statement-breakpoint
-- Every lineage that recorded an edit on a surviving No Work branch: draft write journal
-- threads, and the threads that created, moved or deleted a node.
CREATE TEMP TABLE _lineage_authors ON COMMIT DROP AS
SELECT DISTINCT a.branch_id, t."root_thread_id"
FROM (
  SELECT dd."branch_id", j."thread_id"
  FROM "draft_write_journal" j JOIN "document_drafts" dd ON dd."id" = j."draft_id"
  WHERE j."thread_id" IS NOT NULL
  UNION
  SELECT c."branch_id", c."created_thread_id" FROM "branch_tree_changes" c WHERE c."created_thread_id" IS NOT NULL
  UNION
  SELECT c."branch_id", c."changed_thread_id" FROM "branch_tree_changes" c WHERE c."changed_thread_id" IS NOT NULL
) a
JOIN "threads" t ON t."id" = a."thread_id"
WHERE a.branch_id IN (
  SELECT b."id" FROM "branches" b
  WHERE b."status" = 'active' AND b."origin_work_id" IN (SELECT w."id" FROM "works" w WHERE w."is_no_work"));
--> statement-breakpoint
-- All authors in one lineage of the branch's project: the branch moves there. Several lineages,
-- or none (a branch only the writer touched), stay on the No Work row.
UPDATE "branches" b SET "origin_work_id" = NULL, "origin_root_thread_id" = one."root_thread_id"
FROM (
  SELECT la.branch_id, min(la."root_thread_id"::text)::uuid AS root_thread_id
  FROM _lineage_authors la GROUP BY la.branch_id HAVING count(*) = 1
) one
JOIN "threads" r ON r."id" = one."root_thread_id"
WHERE b."id" = one.branch_id AND b."status" = 'active' AND r."project_id" = b."project_id"
  AND b."origin_work_id" IN (SELECT w."id" FROM "works" w WHERE w."is_no_work");
--> statement-breakpoint
UPDATE "branches" b SET "pending_document_count" = c.count
FROM (
  SELECT br."id" AS branch_id, count(p.document_id)::int AS count
  FROM "branches" br LEFT JOIN _lineage_pending p ON p.branch_id = br."id"
  WHERE br."status" = 'active' GROUP BY br."id"
) c
WHERE b."id" = c.branch_id AND b."pending_document_count" <> c.count;
--> statement-breakpoint
UPDATE "works" w SET "pending_document_count" = c.count, "entity_revision" = w."entity_revision" + 1
FROM (
  SELECT w2."id" AS work_id, coalesce(sum(b."pending_document_count") FILTER (WHERE b."status" = 'active'), 0)::int AS count
  FROM "works" w2 LEFT JOIN "branches" b ON b."origin_work_id" = w2."id"
  WHERE w2."pending_document_count" <> 0 OR EXISTS (SELECT 1 FROM "branches" x WHERE x."origin_work_id" = w2."id" AND x."status" = 'active')
  GROUP BY w2."id"
) c
WHERE w."id" = c.work_id AND w."pending_document_count" <> c.count;
--> statement-breakpoint
COMMIT;
--> statement-breakpoint
ALTER TABLE "branches" VALIDATE CONSTRAINT "branches_one_owner";
--> statement-breakpoint
-- A failed concurrent build leaves an invalid index that IF NOT EXISTS would then skip.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
             WHERE c.relname = 'branches_active_origin_lineage' AND NOT i.indisvalid) THEN
    DROP INDEX "branches_active_origin_lineage";
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "branches_active_origin_lineage" ON "branches" USING btree ("project_id","origin_root_thread_id","created_at") WHERE "branches"."status" = 'active' AND "branches"."origin_root_thread_id" IS NOT NULL;
