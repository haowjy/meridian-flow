-- lineage-repair-start: main's 0009 deleted unrepairable subagent notices
-- without updating cross-thread references. Snapshot the affected derivations
-- before changing them so their complete descendant trees can be re-rooted.
CREATE TEMP TABLE "broken_derivations" ON COMMIT DROP AS
SELECT derived."id", derived."spawn_depth" AS "old_spawn_depth"
FROM "threads" derived
WHERE derived."origin_type" IN ('fork', 'handoff')
  AND derived."origin_turn_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "turns" origin_turn
    WHERE origin_turn."id" = derived."origin_turn_id"
  );
--> statement-breakpoint

-- A derivation is a sibling of its source, so provenance turns are the edge
-- for forks and handoffs. parent_thread_id remains the edge for subagents.
-- Stop at another broken derivation: its own seed makes it the nearest root.
WITH RECURSIVE descendant_subtrees(
  "id", "new_root_thread_id", "depth_shift", "reset_parent_thread_id", "path"
) AS (
  SELECT broken."id", broken."id", broken."old_spawn_depth", true, ARRAY[broken."id"]
  FROM "broken_derivations" broken

  UNION ALL

  SELECT child."id",
         subtree."new_root_thread_id",
         subtree."depth_shift",
         child."origin_type" IN ('fork', 'handoff')
           AND subtree."reset_parent_thread_id",
         subtree."path" || child."id"
  FROM descendant_subtrees subtree
  JOIN "threads" child
    ON (child."origin_type" = 'spawn'
        AND child."parent_thread_id" = subtree."id")
    OR (child."origin_type" IN ('fork', 'handoff')
        AND EXISTS (
          SELECT 1 FROM "turns" origin_turn
          WHERE origin_turn."id" = child."origin_turn_id"
            AND origin_turn."thread_id" = subtree."id"
        ))
  WHERE NOT child."id" = ANY(subtree."path")
    AND NOT EXISTS (
      SELECT 1 FROM "broken_derivations" nested_broken
      WHERE nested_broken."id" = child."id"
    )
)
UPDATE "threads" descendant
SET "root_thread_id" = subtree."new_root_thread_id",
    "spawn_depth" = GREATEST(descendant."spawn_depth" - subtree."depth_shift", 0),
    "parent_thread_id" = CASE
      WHEN subtree."reset_parent_thread_id" THEN NULL
      ELSE descendant."parent_thread_id"
    END
FROM descendant_subtrees subtree
WHERE descendant."id" = subtree."id"
  AND descendant."id" <> subtree."new_root_thread_id";
--> statement-breakpoint

-- Only the affected derived threads can have cross-thread parents deleted by
-- 0009. Any unrelated orphan remains visible to later FK validation.
UPDATE "turns" child
SET "parent_turn_id" = NULL
WHERE child."thread_id" IN (SELECT "id" FROM "broken_derivations")
  AND child."parent_turn_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "turns" parent_turn
    WHERE parent_turn."id" = child."parent_turn_id"
  );
--> statement-breakpoint

-- Preserve each local conversation while dropping only provenance that can no
-- longer be reconstructed. The broken derivation becomes an organic root.
UPDATE "threads" derived
SET "origin_type" = NULL,
    "origin_turn_id" = NULL,
    "parent_thread_id" = NULL,
    "root_thread_id" = derived."id",
    "spawn_depth" = 0,
    "spawn_status" = NULL
FROM "broken_derivations" broken
WHERE derived."id" = broken."id";
-- lineage-repair-end
--> statement-breakpoint

-- Provenance is part of a derived thread's identity. Deleting its source turn
-- must fail while any fork or subagent still refers to it.
ALTER TABLE "threads" ADD CONSTRAINT "threads_origin_turn_id_turns_id_fk" FOREIGN KEY ("origin_turn_id") REFERENCES "public"."turns"("id") ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE NOT VALID;--> statement-breakpoint
ALTER TABLE "threads" VALIDATE CONSTRAINT "threads_origin_turn_id_turns_id_fk";--> statement-breakpoint
ALTER TABLE "thread_execution_reports" DROP CONSTRAINT "thread_execution_reports_publication_valid";--> statement-breakpoint
ALTER TABLE "thread_execution_reports" ADD CONSTRAINT "thread_execution_reports_publication_valid" CHECK ("publication" IN ('none','pending','published'));--> statement-breakpoint
ALTER TABLE "thread_execution_reports" DROP CONSTRAINT "thread_execution_reports_publication_timestamp_coherent";--> statement-breakpoint
ALTER TABLE "thread_execution_reports" ADD CONSTRAINT "thread_execution_reports_publication_timestamp_coherent" CHECK (("publication" IN ('none','pending') AND "published_at" IS NULL) OR ("publication" = 'published' AND "published_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "thread_execution_reports" ADD CONSTRAINT "thread_execution_reports_pending_has_caller" CHECK ("publication" <> 'pending' OR "caller_thread_id" IS NOT NULL);
