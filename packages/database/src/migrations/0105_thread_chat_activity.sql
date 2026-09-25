ALTER TABLE "threads" ADD COLUMN "last_activity_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "conversational_leaf_turn_id" uuid;--> statement-breakpoint
CREATE INDEX "threads_project_activity_primary_active" ON "threads" USING btree ("project_id","last_activity_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "threads"."kind" = 'primary' AND "threads"."deleted_at" IS NULL AND "threads"."status" <> 'archived';--> statement-breakpoint
WITH RECURSIVE lineage AS (
  SELECT t.id AS thread_id, tr.id AS turn_id, tr.parent_turn_id, tr.role,
    tr.metadata, tr.created_at, tr.completed_at, 0 AS depth,
    ARRAY[tr.id]::uuid[] AS path
  FROM threads t JOIN turns tr ON tr.id = t.active_leaf_turn_id
  UNION ALL
  SELECT l.thread_id, parent.id, parent.parent_turn_id, parent.role,
    parent.metadata, parent.created_at, parent.completed_at, l.depth + 1,
    l.path || parent.id
  FROM lineage l JOIN turns parent ON parent.id = l.parent_turn_id
  WHERE NOT parent.id = ANY(l.path)
), visible_heads AS (
  SELECT DISTINCT ON (l.thread_id) l.thread_id, l.turn_id,
    COALESCE(l.completed_at, l.created_at) AS activity_at
  FROM lineage l
  WHERE l.role = 'assistant'
    OR (l.role = 'user' AND NOT (
      COALESCE(l.metadata->>'kind', '') = 'system_update'
      AND COALESCE(l.metadata->>'section', '') = 'work_context'
    ))
    OR (l.role = 'system' AND EXISTS (
      SELECT 1 FROM turn_blocks visible_custom_block
      WHERE visible_custom_block.turn_id = l.turn_id
        AND visible_custom_block.block_type = 'custom'
    ))
  ORDER BY l.thread_id, l.depth
)
UPDATE threads t SET
  conversational_leaf_turn_id = visible_heads.turn_id,
  last_activity_at = COALESCE(visible_heads.activity_at, t.created_at)
FROM visible_heads WHERE visible_heads.thread_id = t.id;
--> statement-breakpoint
UPDATE threads SET last_activity_at = created_at
WHERE conversational_leaf_turn_id IS NULL;
