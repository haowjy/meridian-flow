/** One-statement PostgreSQL projection for flat project chats. */
import { GENERIC_SUBAGENT_NAME } from "@meridian/contracts/agents";
import { sql } from "drizzle-orm";
import type { ProjectChatFeedRepository } from "../../ports/repositories.js";
import { currentDrizzleDb, type DrizzleDatabase } from "./repositories.js";
import {
  exactUtcTimestampSql,
  mapProjectChatRow,
  type ProjectChatSqlRow,
  projectChatPreviewLateral,
  threadActionRequiredSql,
  visibleConversationalTurnSql,
} from "./visible-conversation-sql.js";

export function createDrizzleProjectChatFeedRepository(
  db: DrizzleDatabase,
): ProjectChatFeedRepository {
  return {
    async queryPage(input) {
      const cursorActivity = input.after?.sortAt ?? null;
      const cursorThreadId = input.after?.threadId ?? null;
      const rows = await currentDrizzleDb(db).execute(sql`
        WITH RECURSIVE eligible AS (
          SELECT t.id AS thread_id, t.title,
            t.created_at AS thread_created_at, t.active_leaf_turn_id,
            tw.work_id, w.name AS work_title,
            CASE
              WHEN tab.thread_id IS NULL THEN NULL
              WHEN tab.definition_revision_id IS NULL THEN ${GENERIC_SUBAGENT_NAME}
              ELSE COALESCE(adr.definition->'metadata'->>'name', adr.slug)
            END AS agent_name,
            COALESCE(tus.is_favorite, false) AS is_favorite
          FROM threads t
          JOIN projects p ON p.id = t.project_id AND p.deleted_at IS NULL
          LEFT JOIN thread_works tw ON tw.thread_id = t.id AND tw.is_primary = true
          LEFT JOIN works w ON w.id = tw.work_id AND w.deleted_at IS NULL
          LEFT JOIN thread_agent_bindings tab ON tab.thread_id = t.id
          LEFT JOIN agent_definition_revisions adr
            ON adr.id = tab.definition_revision_id
          LEFT JOIN thread_user_state tus
            ON tus.thread_id = t.id AND tus.user_id = ${input.userId}::uuid
          WHERE t.project_id = ${input.projectId}::uuid
            AND t.kind = 'primary'
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
            l.turn_status AS status, COALESCE(l.completed_at, l.created_at) AS activity_at
          FROM lineage l
          WHERE ${visibleConversationalTurnSql({
            role: sql`l.role`,
            metadata: sql`l.metadata`,
            turnId: sql`l.turn_id`,
          })}
          ORDER BY l.thread_id, l.depth
        ), base AS (
          SELECT e.*, vh.turn_id AS conversational_leaf_turn_id,
            COALESCE(vh.activity_at, e.thread_created_at) AS last_activity_at,
            ${threadActionRequiredSql({
              headRole: sql`vh.role`,
              headStatus: sql`vh.status`,
            })} AS action_required
          FROM eligible e LEFT JOIN visible_heads vh ON vh.thread_id = e.thread_id
        ), selected AS (
          SELECT b.* FROM base b
          WHERE (NOT ${input.favorite} OR b.is_favorite)
            AND (${cursorActivity}::text IS NULL OR
              (b.last_activity_at, b.thread_id) <
              (${cursorActivity}::timestamptz, ${cursorThreadId}::uuid))
          ORDER BY b.last_activity_at DESC, b.thread_id DESC
          LIMIT ${input.limit}
        )
        SELECT selected.thread_id, selected.title,
          selected.work_id, selected.work_title, selected.agent_name,
          selected.action_required, selected.is_favorite,
          conversation_preview.last_message_preview,
          ${exactUtcTimestampSql(sql`selected.last_activity_at`)} AS last_activity_at_exact
        FROM selected
        LEFT JOIN ${projectChatPreviewLateral(sql`selected.conversational_leaf_turn_id`)} ON true
        ORDER BY selected.last_activity_at DESC, selected.thread_id DESC
      `);
      return Array.from(rows as unknown as Iterable<ProjectChatSqlRow>).map(mapProjectChatRow);
    },
  };
}
