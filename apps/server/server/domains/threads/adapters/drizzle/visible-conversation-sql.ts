/** PostgreSQL companion for the visible-conversational-head policy. */
import { type SQL, sql } from "drizzle-orm";

type VisibleTurnColumns = {
  role: SQL;
  metadata: SQL;
  turnId: SQL;
};

type EffectiveAttentionColumns = {
  threadStatus: SQL;
  headRole: SQL;
  headStatus: SQL;
  headActivityAt: SQL;
  manuallyUnread: SQL;
  lastOpenedAt: SQL;
};

/** Canonical SQL predicate for turns that can be the conversational head. */
export function visibleConversationalTurnSql(columns: VisibleTurnColumns): SQL {
  return sql`(
    ${columns.role} = 'assistant'
    OR (${columns.role} = 'user' AND NOT (
      COALESCE(${columns.metadata}->>'kind', '') = 'system_update'
      AND COALESCE(${columns.metadata}->>'section', '') = 'work_context'
    ))
    OR (${columns.role} = 'system' AND EXISTS (
      SELECT 1 FROM turn_blocks visible_custom_block
      WHERE visible_custom_block.turn_id = ${columns.turnId}
        AND visible_custom_block.block_type = 'custom'
    ))
  )`;
}

/** Canonical SQL expression for effective writer attention. */
export function effectiveAttentionSql(columns: EffectiveAttentionColumns): SQL {
  return sql`CASE
    WHEN ${columns.headRole} = 'assistant' AND ${columns.headStatus} = 'waiting_interrupt'
      THEN 'actionRequired'
    WHEN COALESCE(${columns.manuallyUnread}, false) THEN 'unread'
    WHEN ${columns.threadStatus} = 'idle'
      AND ${columns.headRole} = 'assistant' AND ${columns.headStatus} = 'complete'
      AND (${columns.lastOpenedAt} IS NULL OR ${columns.headActivityAt} > ${columns.lastOpenedAt})
      THEN 'unread'
    ELSE 'none'
  END`;
}

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
    WHERE ${visibleConversationalTurnSql({
      role: sql`l.role`,
      metadata: sql`l.metadata`,
      turnId: sql`l.id`,
    })}
    ORDER BY l.depth LIMIT 1
  ) AS conversational_head`;
}
