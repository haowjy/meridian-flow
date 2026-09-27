DROP INDEX "turns_thread_created";--> statement-breakpoint
DROP INDEX "turns_parent_created";--> statement-breakpoint
ALTER TABLE "turn_blocks" ADD COLUMN "image_included" boolean;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "position" integer;--> statement-breakpoint
DO $$
DECLARE
  thread_row record;
  position_base integer;
BEGIN
  FOR thread_row IN
    WITH RECURSIVE fork_order AS (
      SELECT thread.id, 0 AS depth, ARRAY[thread.id] AS path
      FROM threads thread
      WHERE thread.origin_type IS DISTINCT FROM 'fork'
      UNION ALL
      SELECT fork.id, source.depth + 1, source.path || fork.id
      FROM threads fork
      JOIN turns cutoff ON cutoff.id = fork.origin_turn_id
      JOIN fork_order source ON source.id = cutoff.thread_id
      WHERE fork.origin_type = 'fork' AND NOT fork.id = ANY(source.path)
    )
    SELECT id
    FROM fork_order
    ORDER BY depth, id
  LOOP
    position_base := 0;
    IF EXISTS (
      SELECT 1 FROM threads
      WHERE id = thread_row.id AND origin_type = 'fork'
    ) THEN
      SELECT cutoff.position INTO position_base
      FROM threads fork
      JOIN turns cutoff ON cutoff.id = fork.origin_turn_id
      WHERE fork.id = thread_row.id;
      IF position_base IS NULL THEN
        RAISE EXCEPTION 'Cannot backfill fork % without a positioned cutoff turn', thread_row.id;
      END IF;
    END IF;

    WITH RECURSIVE local_turns AS (
      SELECT turn.id, turn.parent_turn_id, turn.created_at, 1 AS depth, ARRAY[turn.id] AS path
      FROM turns turn
      WHERE turn.thread_id = thread_row.id
        AND (
          turn.parent_turn_id IS NULL
          OR turn.parent_turn_id = (
            SELECT fork.origin_turn_id
            FROM threads fork
            WHERE fork.id = thread_row.id AND fork.origin_type = 'fork'
          )
        )
      UNION ALL
      SELECT child.id, child.parent_turn_id, child.created_at, parent.depth + 1, parent.path || child.id
      FROM turns child
      JOIN local_turns parent ON parent.id = child.parent_turn_id
      WHERE child.thread_id = thread_row.id AND NOT child.id = ANY(parent.path)
    ), ordered_turns AS (
      SELECT turn.id, local.depth, turn.created_at
      FROM turns turn
      JOIN local_turns local ON local.id = turn.id
      WHERE turn.thread_id = thread_row.id
      UNION ALL
      SELECT turn.id, COALESCE((SELECT MAX(depth) FROM local_turns), 0) + 1, turn.created_at
      FROM turns turn
      WHERE turn.thread_id = thread_row.id
        AND NOT EXISTS (SELECT 1 FROM local_turns local WHERE local.id = turn.id)
    ), ranked_turns AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY depth, created_at, id)::integer AS ordinal
      FROM ordered_turns
    )
    UPDATE turns turn
    SET position = position_base + ranked.ordinal
    FROM ranked_turns ranked
    WHERE turn.id = ranked.id;
  END LOOP;
END;
$$;--> statement-breakpoint
ALTER TABLE "turns" ALTER COLUMN "position" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "turns_thread_position_unique" ON "turns" USING btree ("thread_id","position");--> statement-breakpoint
CREATE INDEX "turns_parent_position" ON "turns" USING btree ("parent_turn_id","position" DESC NULLS LAST) WHERE "turns"."parent_turn_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "turn_blocks" ADD CONSTRAINT "turn_blocks_image_inclusion_only" CHECK ("turn_blocks"."block_type" = 'image' OR "turn_blocks"."image_included" IS NULL);--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_position_positive" CHECK ("turns"."position" > 0);--> statement-breakpoint
CREATE FUNCTION enforce_turn_position_write_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.position IS DISTINCT FROM OLD.position THEN
    RAISE EXCEPTION 'Turn position is write-once'
      USING ERRCODE = '23514', CONSTRAINT = 'turns_position_write_once';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER turns_position_write_once
BEFORE UPDATE OF position ON turns
FOR EACH ROW EXECUTE FUNCTION enforce_turn_position_write_once();
