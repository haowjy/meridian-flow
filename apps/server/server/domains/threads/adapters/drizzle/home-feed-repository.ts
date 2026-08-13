/** One-statement PostgreSQL projection for Continue, Favorite, and Recent Home chats. */
import type { HomeChatAttention, HomeChatItem } from "@meridian/contracts/threads";
import { sql } from "drizzle-orm";
import type { HomeChatFeedRepository } from "../../ports/repositories.js";
import { currentDrizzleDb, type DrizzleDatabase } from "./repositories.js";

type HomeRow = {
  section: "continue" | "favorite" | "recent";
  thread_id: string;
  title: string;
  work_id: string | null;
  work_title: string | null;
  last_message_preview: string | null;
  last_activity_at_exact: string;
  attention: HomeChatAttention;
  is_favorite: boolean;
};

function mapRow(row: HomeRow): HomeChatItem {
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

export function createDrizzleHomeChatFeedRepository(db: DrizzleDatabase): HomeChatFeedRepository {
  return {
    async queryPage(input) {
      const cursorActivity = input.after?.lastActivityAt ?? null;
      const cursorThreadId = input.after?.threadId ?? null;
      const rows = await currentDrizzleDb(db).execute(sql`
        WITH RECURSIVE eligible AS (
          SELECT t.id AS thread_id, t.title, t.status AS thread_status,
            t.created_at AS thread_created_at, t.active_leaf_turn_id,
            tw.work_id, w.name AS work_title,
            COALESCE(tus.is_favorite, false) AS is_favorite,
            COALESCE(tus.manually_unread, false) AS manually_unread,
            tus.last_opened_at
          FROM threads t
          JOIN projects p ON p.id = t.project_id AND p.deleted_at IS NULL
          LEFT JOIN thread_works tw ON tw.thread_id = t.id AND tw.is_primary = true
          LEFT JOIN works w ON w.id = tw.work_id AND w.deleted_at IS NULL
          LEFT JOIN thread_user_state tus
            ON tus.thread_id = t.id AND tus.user_id = ${input.userId}::uuid
          WHERE t.project_id = ${input.projectId}::uuid
            AND t.deleted_at IS NULL AND t.status <> 'archived'
        ), lineage AS (
          SELECT e.thread_id, tr.id AS turn_id, tr.parent_turn_id, tr.role,
            tr.status AS turn_status, tr.metadata, tr.created_at, tr.completed_at,
            0 AS depth, ARRAY[tr.id]::uuid[] AS path
          FROM eligible e JOIN turns tr ON tr.id = e.active_leaf_turn_id
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
          WHERE l.role = 'assistant'
            OR (l.role = 'user' AND NOT (
              COALESCE(l.metadata->>'kind', '') = 'system_update'
              AND COALESCE(l.metadata->>'section', '') = 'work_context'))
            OR (l.role = 'system' AND EXISTS (
              SELECT 1 FROM turn_blocks cb
              WHERE cb.turn_id = l.turn_id AND cb.block_type = 'custom'))
          ORDER BY l.thread_id, l.depth
        ), base AS (
          SELECT e.*, vh.turn_id AS conversational_leaf_turn_id,
            COALESCE(vh.conversational_activity_at, e.thread_created_at) AS last_activity_at,
            CASE
              WHEN vh.role = 'assistant' AND vh.turn_status = 'waiting_interrupt'
                THEN 'actionRequired'
              WHEN e.manually_unread THEN 'unread'
              WHEN e.thread_status = 'idle' AND vh.role = 'assistant'
                AND vh.turn_status = 'complete'
                AND (e.last_opened_at IS NULL OR vh.conversational_activity_at > e.last_opened_at)
                THEN 'unread'
              ELSE 'none'
            END AS attention
          FROM eligible e LEFT JOIN visible_heads vh ON vh.thread_id = e.thread_id
        ), continue_row AS (
          SELECT thread_id FROM base ORDER BY last_activity_at DESC, thread_id DESC LIMIT 1
        ), selected AS (
          SELECT 'continue'::text AS section, b.* FROM base b
          JOIN continue_row c USING (thread_id) WHERE ${input.includeFeatured}
          UNION ALL
          SELECT 'favorite', b.* FROM base b
          WHERE ${input.includeFeatured} AND b.is_favorite
            AND b.thread_id <> (SELECT thread_id FROM continue_row)
          UNION ALL
          SELECT 'recent', recent.* FROM (
            SELECT b.* FROM base b
            WHERE NOT b.is_favorite
              AND b.thread_id <> (SELECT thread_id FROM continue_row)
              AND (${cursorActivity}::text IS NULL OR
                (b.last_activity_at, b.thread_id) <
                (${cursorActivity}::timestamptz, ${cursorThreadId}::uuid))
            ORDER BY b.last_activity_at DESC, b.thread_id DESC
            LIMIT ${input.recentLimit}
          ) recent
        )
        SELECT selected.section, selected.thread_id, selected.title,
          selected.work_id, selected.work_title, selected.attention, selected.is_favorite,
          NULLIF(left(btrim(regexp_replace(COALESCE(preview.message_text, ''),
            '[[:space:]]+', ' ', 'g')), 240), '') AS last_message_preview,
          to_char(selected.last_activity_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS last_activity_at_exact
        FROM selected
        LEFT JOIN LATERAL (
          SELECT string_agg(NULLIF(block.model_text, ''), ' ' ORDER BY block.sequence) AS message_text
          FROM turn_blocks block
          WHERE block.turn_id = selected.conversational_leaf_turn_id
            AND block.block_type = 'text' AND block.pruned = false
        ) preview ON true
        ORDER BY CASE selected.section WHEN 'continue' THEN 0 WHEN 'favorite' THEN 1 ELSE 2 END,
          selected.last_activity_at DESC, selected.thread_id DESC
      `);
      const mapped = Array.from(rows as unknown as Iterable<HomeRow>).map((row) => ({
        section: row.section,
        item: mapRow(row),
      }));
      return {
        continueChat: mapped.find((row) => row.section === "continue")?.item ?? null,
        favorites: mapped.filter((row) => row.section === "favorite").map((row) => row.item),
        recent: mapped.filter((row) => row.section === "recent").map((row) => row.item),
      };
    },
  };
}
