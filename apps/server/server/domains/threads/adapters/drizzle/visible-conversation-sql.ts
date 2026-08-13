/** PostgreSQL companion for the visible-conversational-head policy. */
import { type SQL, sql } from "drizzle-orm";

/** One correlated row named `conversational_head`, or no row for an empty chat. */
export function visibleConversationalHeadLateral(activeLeafTurnId: SQL): SQL {
  return sql`LATERAL (
    WITH RECURSIVE lineage AS (
      SELECT tr.id, tr.parent_turn_id, tr.role, tr.status, tr.metadata,
        tr.created_at, tr.completed_at, 0 AS depth, ARRAY[tr.id]::uuid[] AS path
      FROM turns tr WHERE tr.id = ${activeLeafTurnId}
      UNION ALL
      SELECT parent.id, parent.parent_turn_id, parent.role, parent.status, parent.metadata,
        parent.created_at, parent.completed_at, l.depth + 1, l.path || parent.id
      FROM lineage l JOIN turns parent ON parent.id = l.parent_turn_id
      WHERE NOT parent.id = ANY(l.path)
    )
    SELECT l.role, l.status,
      COALESCE(l.completed_at, l.created_at) AS activity_at
    FROM lineage l
    WHERE l.role = 'assistant'
      OR (l.role = 'user' AND NOT (
        COALESCE(l.metadata->>'kind', '') = 'system_update'
        AND COALESCE(l.metadata->>'section', '') = 'work_context'))
      OR (l.role = 'system' AND EXISTS (
        SELECT 1 FROM turn_blocks b
        WHERE b.turn_id = l.id AND b.block_type = 'custom'))
    ORDER BY l.depth LIMIT 1
  ) AS conversational_head`;
}
