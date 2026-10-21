-- migration: no-transaction
-- Online half of 0082_owner_handles. Re-runnable, with each data page committed.
-- This temporary seek index bounds work per page without sorting the whole table.
CREATE INDEX CONCURRENTLY IF NOT EXISTS owner_handle_cutover_pending ON works (created_at, id)
  WHERE handle IS NULL AND NOT is_no_work;
--> statement-breakpoint
CREATE OR REPLACE PROCEDURE backfill_owner_handles(batch_size integer) LANGUAGE plpgsql AS $$
DECLARE
  counter_cursor uuid; counter_ids uuid[];
  work_ids uuid[]; work_id uuid;
BEGIN
  -- Cleanup may have committed before the runner could record this file.
  IF to_regclass('project_thread_counters') IS NOT NULL THEN
    LOOP
      SET LOCAL lock_timeout = '2s';
      IF counter_cursor IS NULL THEN
        SELECT array_agg(project_id ORDER BY project_id) INTO counter_ids FROM (
          SELECT project_id FROM project_thread_counters ORDER BY project_id LIMIT batch_size
        ) page;
      ELSE
        SELECT array_agg(project_id ORDER BY project_id) INTO counter_ids FROM (
          SELECT project_id FROM project_thread_counters WHERE project_id > counter_cursor
            ORDER BY project_id LIMIT batch_size
        ) page;
      END IF;
      EXIT WHEN counter_ids IS NULL;
      INSERT INTO project_handle_counters (project_id, kind, n)
        SELECT project_id, 'thread', n FROM project_thread_counters
        WHERE project_id = ANY(counter_ids)
        ON CONFLICT (project_id, kind) DO UPDATE
          SET n = greatest(project_handle_counters.n, EXCLUDED.n);
      counter_cursor := counter_ids[array_length(counter_ids, 1)];
      COMMIT;
    END LOOP;
  END IF;
  LOOP
    SET LOCAL lock_timeout = '2s';
    SELECT array_agg(id ORDER BY created_at, id) INTO work_ids FROM (
      SELECT id, created_at FROM works WHERE handle IS NULL AND NOT is_no_work
        ORDER BY created_at, id LIMIT batch_size FOR UPDATE
    ) page;
    EXIT WHEN work_ids IS NULL;
    -- Retain creation order within each project, including soft-deleted Works.
    -- The trigger advances the counter atomically, never a count(*)-based reset
    -- that could collide with a concurrent creator or an earlier committed page.
    FOREACH work_id IN ARRAY work_ids LOOP
      UPDATE works SET handle = handle WHERE id = work_id AND handle IS NULL;
    END LOOP;
    COMMIT;
  END LOOP;
END $$;
--> statement-breakpoint
CALL backfill_owner_handles(500);
--> statement-breakpoint
DROP PROCEDURE IF EXISTS backfill_owner_handles(integer);
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS owner_handle_cutover_pending;
--> statement-breakpoint
ALTER TABLE project_handle_counters VALIDATE CONSTRAINT project_handle_counters_project_id_projects_id_fk;
--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "works_project_handle" ON "works" USING btree ("project_id","handle") WHERE "handle" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "works" VALIDATE CONSTRAINT "works_no_work_handle";
--> statement-breakpoint
ALTER TABLE "works" VALIDATE CONSTRAINT "works_handle_valid";
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "works_project_slug";
--> statement-breakpoint
BEGIN;
SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
DROP TRIGGER IF EXISTS owner_handle_cutover_allocate ON works;
DROP FUNCTION IF EXISTS owner_handle_cutover_allocate();
ALTER TABLE "works" DROP COLUMN IF EXISTS "slug"; -- migration-lint: skip DROP_COLUMN (0083 assigned every named Work a permanent handle; names and owner IDs are preserved and no reader uses slug)
--> statement-breakpoint
DROP TABLE IF EXISTS "project_thread_counters"; -- migration-lint: skip DROP_TABLE (0083 copied every counter into project_handle_counters)

--> statement-breakpoint
COMMIT;
