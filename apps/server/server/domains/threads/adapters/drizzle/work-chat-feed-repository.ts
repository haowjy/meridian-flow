/** Bounded Work-associated chat projection with current primary-Work identity. */
import type { ProjectChatAttention, ProjectChatItem } from "@meridian/contracts/threads";
import { sql } from "drizzle-orm";
import type { WorkChatFeedRepository, WorkChatFeedRow } from "../../ports/repositories.js";
import { currentDrizzleDb, type DrizzleDatabase } from "./repositories.js";
import { effectiveAttentionSql, visibleConversationalTurnSql } from "./visible-conversation-sql.js";

type WorkRow = {
  thread_id: string;
  title: string;
  work_id: string | null;
  work_title: string | null;
  last_message_preview: string | null;
  last_activity_at_exact: string;
  updated_at_exact: string;
  attention: ProjectChatAttention;
  is_favorite: boolean;
};

function mapRow(row: WorkRow): WorkChatFeedRow {
  const item: ProjectChatItem = {
    id: row.thread_id,
    title: row.title,
    work: row.work_id && row.work_title ? { id: row.work_id, title: row.work_title } : null,
    lastMessagePreview: row.last_message_preview,
    lastActivityAt: row.last_activity_at_exact,
    attention: row.attention,
    isFavorite: row.is_favorite,
  };
  return { item, updatedAt: row.updated_at_exact };
}

export function createDrizzleWorkChatFeedRepository(db: DrizzleDatabase): WorkChatFeedRepository {
  return {
    async queryPage(input) {
      const cursorUpdatedAt = input.after?.updatedAt ?? null;
      const cursorThreadId = input.after?.threadId ?? null;
      const rows = await currentDrizzleDb(db).execute(sql`
        WITH RECURSIVE selected AS (
          SELECT t.id AS thread_id, COALESCE(t.title, '') AS title,
            t.status AS thread_status, t.created_at AS thread_created_at,
            t.updated_at, t.active_leaf_turn_id,
            primary_tw.work_id, primary_work.name AS work_title,
            COALESCE(tus.is_favorite, false) AS is_favorite,
            COALESCE(tus.manually_unread, false) AS manually_unread,
            tus.last_opened_at
          FROM threads t
          JOIN projects p ON p.id = t.project_id AND p.deleted_at IS NULL
          JOIN thread_works matched_tw
            ON matched_tw.thread_id = t.id AND matched_tw.work_id = ${input.workId}::uuid
          LEFT JOIN thread_works primary_tw
            ON primary_tw.thread_id = t.id AND primary_tw.is_primary = true
          LEFT JOIN works primary_work
            ON primary_work.id = primary_tw.work_id AND primary_work.deleted_at IS NULL
          LEFT JOIN thread_user_state tus
            ON tus.thread_id = t.id AND tus.user_id = ${input.userId}::uuid
          WHERE t.project_id = ${input.projectId}::uuid AND t.deleted_at IS NULL
            AND (${cursorUpdatedAt}::text IS NULL OR
              (t.updated_at, t.id) < (${cursorUpdatedAt}::timestamptz, ${cursorThreadId}::uuid))
          ORDER BY t.updated_at DESC, t.id DESC
          LIMIT ${input.limit}
        ), lineage AS (
          SELECT s.thread_id, tr.id AS turn_id, tr.parent_turn_id, tr.role,
            tr.status AS turn_status, tr.metadata, tr.created_at, tr.completed_at,
            0 AS depth, ARRAY[tr.id]::uuid[] AS path
          FROM selected s JOIN turns tr ON tr.id = s.active_leaf_turn_id
          UNION ALL
          SELECT l.thread_id, parent.id, parent.parent_turn_id, parent.role,
            parent.status, parent.metadata, parent.created_at, parent.completed_at,
            l.depth + 1, l.path || parent.id
          FROM lineage l JOIN turns parent ON parent.id = l.parent_turn_id
          WHERE NOT parent.id = ANY(l.path)
        ), visible_heads AS (
          SELECT DISTINCT ON (l.thread_id) l.thread_id, l.turn_id, l.role,
            l.turn_status, COALESCE(l.completed_at, l.created_at) AS conversational_activity_at
          FROM lineage l
          WHERE ${visibleConversationalTurnSql({
            role: sql`l.role`,
            metadata: sql`l.metadata`,
            turnId: sql`l.turn_id`,
          })}
          ORDER BY l.thread_id, l.depth
        ), projected AS (
          SELECT s.*, vh.turn_id AS conversational_leaf_turn_id,
            COALESCE(vh.conversational_activity_at, s.thread_created_at) AS last_activity_at,
            ${effectiveAttentionSql({
              threadStatus: sql`s.thread_status`,
              headRole: sql`vh.role`,
              headStatus: sql`vh.turn_status`,
              headActivityAt: sql`vh.conversational_activity_at`,
              manuallyUnread: sql`s.manually_unread`,
              lastOpenedAt: sql`s.last_opened_at`,
            })} AS attention
          FROM selected s LEFT JOIN visible_heads vh ON vh.thread_id = s.thread_id
        )
        SELECT projected.thread_id, projected.title, projected.work_id,
          projected.work_title, projected.attention, projected.is_favorite,
          NULLIF(left(btrim(regexp_replace(COALESCE(preview.message_text, ''),
            '[[:space:]]+', ' ', 'g')), 240), '') AS last_message_preview,
          to_char(projected.last_activity_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS last_activity_at_exact,
          to_char(projected.updated_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at_exact
        FROM projected
        LEFT JOIN LATERAL (
          SELECT string_agg(NULLIF(block.model_text, ''), ' ' ORDER BY block.sequence) AS message_text
          FROM turn_blocks block
          WHERE block.turn_id = projected.conversational_leaf_turn_id
            AND block.block_type = 'text' AND block.pruned = false
        ) preview ON true
        ORDER BY projected.updated_at DESC, projected.thread_id DESC
      `);
      return Array.from(rows as unknown as Iterable<WorkRow>).map(mapRow);
    },
  };
}
