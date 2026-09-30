-- main's 0009 deleted unrepairable subagent notices without updating
-- cross-thread references. Preserve local history while dropping lineage that
-- can no longer be reconstructed, and make affected first local turns roots.
UPDATE "threads" derived
SET "origin_type" = NULL,
    "origin_turn_id" = NULL,
    "parent_thread_id" = NULL,
    "root_thread_id" = derived."id",
    "spawn_depth" = 0,
    "spawn_status" = NULL
WHERE derived."origin_type" IN ('fork', 'handoff')
  AND derived."origin_turn_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "turns" origin_turn
    WHERE origin_turn."id" = derived."origin_turn_id"
  );
--> statement-breakpoint

UPDATE "turns" child
SET "parent_turn_id" = NULL
WHERE child."parent_turn_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "turns" parent_turn
    WHERE parent_turn."id" = child."parent_turn_id"
  );
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
