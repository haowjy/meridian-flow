/** Canonical PostgreSQL projection machinery for visible Project-chat rows. */
import type { ProjectChatItem, ThreadAttention } from "@meridian/contracts/threads";
import { type SQL, sql } from "drizzle-orm";

export type ProjectChatSqlRow = {
  thread_id: string;
  title: string;
  work_id: string | null;
  work_title: string | null;
  last_message_preview: string | null;
  last_activity_at_exact: string;
  attention: ThreadAttention;
  is_favorite: boolean;
};

export function mapProjectChatRow(row: ProjectChatSqlRow): ProjectChatItem {
  return {
    id: row.thread_id,
    title: row.title,
    work: row.work_id && row.work_title ? { id: row.work_id, title: row.work_title } : null,
    lastMessagePreview: row.last_message_preview,
    lastActivityAt: row.last_activity_at_exact,
    attention: row.attention,
    isFavorite: row.is_favorite,
  };
}

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
    SELECT l.id AS turn_id, l.role, l.status,
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

/** One correlated, whitespace-normalized 240-character visible-head preview. */
export function projectChatPreviewLateral(headTurnId: SQL): SQL {
  return sql`LATERAL (
    SELECT NULLIF(left(btrim(regexp_replace(COALESCE(
      string_agg(NULLIF(block.model_text, ''), ' ' ORDER BY block.sequence), ''),
      '[[:space:]]+', ' ', 'g')), 240), '') AS last_message_preview
    FROM turn_blocks block
    WHERE block.turn_id = ${headTurnId}
      AND block.block_type = 'text' AND block.pruned = false
  ) AS conversation_preview`;
}

/** Exact PostgreSQL microsecond timestamp encoded for the JSON contract. */
export function exactUtcTimestampSql(value: SQL): SQL<string> {
  return sql<string>`to_char(${value} AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}
