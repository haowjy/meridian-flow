-- REQUIRES ALL WRITERS STOPPED from before 0090 until this file completes: a release older than
-- 0090 records drafted tree entries without the ownership 0090 and 0091 track, which only this
-- reconstruction recovers. See packages/database/.context/CONTEXT.md.
--
-- Reconstructs what an active branch's drafted tree entries own (PR 3 phase H) from the edit
-- history, as the runtime would have recorded it: 0090 and 0091 started both tables from the
-- current rows alone. A branch's outstanding entries on a document are its tree rows after its
-- latest settlement there; every entry before one belongs to a proposal that settlement ended.
--   * Every folder an outstanding row moved the document into is held (`branch_tree_folders`),
--     as the facts writer holds each, and the current row's; resolved through
--     `folders.absorbed_into`, as absorption transfers holds.
--   * The document is unsettled (`branch_tree_unsettled`) if an outstanding move, delete or
--     revert there was not rolled back (undone ones count: an undo can leave no current row),
--     if the current row moves or deletes it, or if a folder is held for it.
-- Only the two new tables are written (ON CONFLICT DO NOTHING, so a rerun adds nothing); the
-- history is read once, under ACCESS SHARE.
CREATE TEMP TABLE "branch_tree_outstanding" ON COMMIT DROP AS
WITH "tree" AS (
	SELECT e."id", e."document_id", e."kind", e."tree_change" AS "change",
		(e."tree_change"->'destination'->>'branchId')::uuid AS "branch_id",
		(e."tree_change"->>'seq')::bigint AS "seq"
	FROM "document_edits" e
	WHERE e."tree_change" IS NOT NULL AND e."tree_change"->'destination'->>'kind' = 'draft'
)
SELECT t.* FROM "tree" t
JOIN "branches" b ON b."id" = t."branch_id" AND b."status" = 'active'
WHERE t."seq" > coalesce((
	SELECT max(s."seq") FROM "tree" s
	WHERE s."branch_id" = t."branch_id" AND s."document_id" = t."document_id"
		AND s."change"->>'op' = 'settle'
), -1);
--> statement-breakpoint
INSERT INTO "branch_tree_folders" ("branch_id", "document_id", "folder_id")
WITH RECURSIVE "held" AS (
	SELECT o."branch_id", o."document_id", (o."change"->'after'->'moved'->>'folderId')::uuid AS "folder_id"
	FROM "branch_tree_outstanding" o
	WHERE o."change"->'after'->'moved'->>'folderId' IS NOT NULL
	UNION
	SELECT c."branch_id", c."node_id", c."moved_folder_id"
	FROM "branch_tree_changes" c
	JOIN "branches" b ON b."id" = c."branch_id" AND b."status" = 'active'
	WHERE c."node_kind" = 'document' AND c."moved" AND c."moved_folder_id" IS NOT NULL
), "resolved" AS (
	SELECT "branch_id", "document_id", "folder_id" FROM "held"
	UNION
	SELECT r."branch_id", r."document_id", f."absorbed_into"
	FROM "resolved" r JOIN "folders" f ON f."id" = r."folder_id"
	WHERE f."absorbed_into" IS NOT NULL
)
SELECT r."branch_id", r."document_id", r."folder_id"
FROM "resolved" r JOIN "folders" f ON f."id" = r."folder_id"
WHERE f."absorbed_into" IS NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "branch_tree_unsettled" ("branch_id", "document_id")
SELECT o."branch_id", o."document_id"
FROM "branch_tree_outstanding" o
WHERE o."kind" IN ('write', 'revert')
	AND NOT EXISTS (
		SELECT 1 FROM "branch_tree_outstanding" r
		WHERE r."branch_id" = o."branch_id" AND r."document_id" = o."document_id"
			AND r."kind" = 'rollback'
			AND r."change"->'targets' @> jsonb_build_array(jsonb_build_object('editId', o."id"::text))
	)
UNION
SELECT c."branch_id", c."node_id"
FROM "branch_tree_changes" c
JOIN "branches" b ON b."id" = c."branch_id" AND b."status" = 'active'
WHERE c."node_kind" = 'document' AND (c."moved" OR c."deleted")
UNION
SELECT "branch_id", "document_id" FROM "branch_tree_folders"
ON CONFLICT DO NOTHING;
