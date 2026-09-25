/** Canonical PostgreSQL projection machinery for visible Project-chat rows. */
import { GENERIC_SUBAGENT_NAME } from "@meridian/contracts/agents";
import type { ProjectChatItem } from "@meridian/contracts/threads";
import { type SQL, sql } from "drizzle-orm";

export type ProjectChatSqlRow = {
  thread_id: string;
  title: string;
  work_id: string | null;
  work_title: string | null;
  agent_name: string | null;
  last_message_preview: string | null;
  last_activity_at_exact: string;
  action_required: boolean;
  is_favorite: boolean;
};

export function mapProjectChatRow(row: ProjectChatSqlRow): ProjectChatItem {
  return {
    id: row.thread_id,
    title: row.title,
    work: row.work_id && row.work_title ? { id: row.work_id, title: row.work_title } : null,
    agentName: row.agent_name,
    lastMessagePreview: row.last_message_preview,
    lastActivityAt: row.last_activity_at_exact,
    actionRequired: row.action_required,
    isFavorite: row.is_favorite,
  };
}

type ActionRequiredColumns = {
  headRole: SQL;
  headStatus: SQL;
};

/** Canonical SQL expression for a chat paused for the writer's answer. */
export function threadActionRequiredSql(columns: ActionRequiredColumns): SQL<boolean> {
  return sql<boolean>`COALESCE(
    ${columns.headRole} = 'assistant' AND ${columns.headStatus} = 'waiting_interrupt', false
  )`;
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

/**
 * Full chat-row projection for a candidate set of thread ids. Callers supply
 * only the candidate scope and order (a `SELECT ... AS thread_id` body, most
 * recent first); this owns the primary-Work join, the agent_name CASE, the
 * favorite join, the head-turn lookup, the preview lateral, and timestamp
 * formatting shared by the Project and Work chat feeds.
 */
export function chatFeedRowsSql(input: { candidates: SQL; userId: string }): SQL {
  return sql`
    WITH candidates AS (${input.candidates})
    SELECT t.id AS thread_id, t.title,
      primary_work.work_id, primary_work.work_title, agent.agent_name,
      ${threadActionRequiredSql({
        headRole: sql`head.role`,
        headStatus: sql`head.status`,
      })} AS action_required,
      COALESCE(tus.is_favorite, false) AS is_favorite,
      conversation_preview.last_message_preview,
      ${exactUtcTimestampSql(sql`t.last_activity_at`)} AS last_activity_at_exact
    FROM candidates
    JOIN threads t ON t.id = candidates.thread_id
    LEFT JOIN LATERAL (
      SELECT tw.work_id, w.name AS work_title
      FROM thread_works tw LEFT JOIN works w ON w.id = tw.work_id AND w.deleted_at IS NULL
      WHERE tw.thread_id = t.id AND tw.is_primary = true
    ) primary_work ON true
    LEFT JOIN LATERAL (
      SELECT CASE WHEN tab.thread_id IS NULL THEN NULL
        WHEN tab.definition_revision_id IS NULL THEN ${GENERIC_SUBAGENT_NAME}
        ELSE COALESCE(adr.definition->'metadata'->>'name', adr.slug) END AS agent_name
      FROM thread_agent_bindings tab
      LEFT JOIN agent_definition_revisions adr ON adr.id = tab.definition_revision_id
      WHERE tab.thread_id = t.id
    ) agent ON true
    LEFT JOIN thread_user_state tus ON tus.thread_id = t.id AND tus.user_id = ${input.userId}::uuid
    LEFT JOIN turns head ON head.id = t.conversational_leaf_turn_id
    LEFT JOIN ${projectChatPreviewLateral(sql`t.conversational_leaf_turn_id`)} ON true
    ORDER BY t.last_activity_at DESC, t.id DESC
  `;
}
