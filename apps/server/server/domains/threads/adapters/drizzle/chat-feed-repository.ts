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
} from "./visible-conversation-sql.js";

export function createDrizzleProjectChatFeedRepository(
  db: DrizzleDatabase,
): ProjectChatFeedRepository {
  return {
    async queryPage(input) {
      const cursorActivity = input.after?.sortAt ?? null;
      const cursorThreadId = input.after?.threadId ?? null;
      // LIKE metacharacters in the writer's text match literally.
      const searchPattern = input.search
        ? `%${input.search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`
        : null;
      const rows = await currentDrizzleDb(db).execute(sql`
        WITH selected AS (
          SELECT t.id AS thread_id, t.title, t.last_activity_at,
            t.conversational_leaf_turn_id,
            COALESCE(tus.is_favorite, false) AS is_favorite
          FROM threads t
          JOIN projects p ON p.id = t.project_id AND p.deleted_at IS NULL
          LEFT JOIN thread_user_state tus
            ON tus.thread_id = t.id AND tus.user_id = ${input.userId}::uuid
          WHERE t.project_id = ${input.projectId}::uuid
            AND t.kind = 'primary'
            AND t.deleted_at IS NULL AND t.status <> 'archived'
            AND (NOT ${input.favorite} OR COALESCE(tus.is_favorite, false))
            AND (${searchPattern}::text IS NULL OR t.title ILIKE ${searchPattern} ESCAPE '\\')
            AND (${cursorActivity}::text IS NULL OR
              (t.last_activity_at, t.id) <
              (${cursorActivity}::timestamptz, ${cursorThreadId}::uuid))
          ORDER BY t.last_activity_at DESC, t.id DESC
          LIMIT ${input.limit}
        )
        SELECT selected.thread_id, selected.title,
          primary_work.work_id, primary_work.work_title, agent.agent_name,
          ${threadActionRequiredSql({
            headRole: sql`head.role`,
            headStatus: sql`head.status`,
          })} AS action_required, selected.is_favorite,
          conversation_preview.last_message_preview,
          ${exactUtcTimestampSql(sql`selected.last_activity_at`)} AS last_activity_at_exact
        FROM selected
        LEFT JOIN LATERAL (
          SELECT tw.work_id, w.name AS work_title
          FROM thread_works tw LEFT JOIN works w ON w.id = tw.work_id AND w.deleted_at IS NULL
          WHERE tw.thread_id = selected.thread_id AND tw.is_primary = true
        ) primary_work ON true
        LEFT JOIN LATERAL (
          SELECT CASE WHEN tab.thread_id IS NULL THEN NULL
            WHEN tab.definition_revision_id IS NULL THEN ${GENERIC_SUBAGENT_NAME}
            ELSE COALESCE(adr.definition->'metadata'->>'name', adr.slug) END AS agent_name
          FROM thread_agent_bindings tab
          LEFT JOIN agent_definition_revisions adr ON adr.id = tab.definition_revision_id
          WHERE tab.thread_id = selected.thread_id
        ) agent ON true
        LEFT JOIN LATERAL (
          SELECT turn.role, turn.status
          FROM turns turn WHERE turn.id = selected.conversational_leaf_turn_id
        ) head ON true
        LEFT JOIN ${projectChatPreviewLateral(sql`selected.conversational_leaf_turn_id`)} ON true
        ORDER BY selected.last_activity_at DESC, selected.thread_id DESC
      `);
      return Array.from(rows as unknown as Iterable<ProjectChatSqlRow>).map(mapProjectChatRow);
    },
  };
}
