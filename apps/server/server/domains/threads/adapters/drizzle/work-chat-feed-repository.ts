/** Bounded Work-associated Project-chat projection with current primary-Work identity. */
import { GENERIC_SUBAGENT_NAME } from "@meridian/contracts/agents";
import { sql } from "drizzle-orm";
import type { WorkChatFeedRepository, WorkChatFeedRow } from "../../ports/repositories.js";
import { currentDrizzleDb, type DrizzleDatabase } from "./repositories.js";
import {
  exactUtcTimestampSql,
  mapProjectChatRow,
  type ProjectChatSqlRow,
  projectChatPreviewLateral,
  threadActionRequiredSql,
} from "./visible-conversation-sql.js";
import { workAssociationCandidatesSql } from "./work-association-candidates-sql.js";

type WorkRow = ProjectChatSqlRow & { updated_at_exact: string };

export function createDrizzleWorkChatFeedRepository(db: DrizzleDatabase): WorkChatFeedRepository {
  return {
    async queryPage(input) {
      const rows = await currentDrizzleDb(db).execute(sql`
        WITH candidates AS (${workAssociationCandidatesSql({
          projectId: input.projectId,
          workId: input.workId,
          afterSortAt: input.after?.sortAt ?? null,
          afterThreadId: input.after?.threadId ?? null,
          limit: input.limit,
        })})
        SELECT t.id AS thread_id, COALESCE(t.title, '') AS title,
          primary_tw.work_id, primary_work.name AS work_title,
          CASE
            WHEN tab.thread_id IS NULL THEN NULL
            WHEN tab.definition_revision_id IS NULL THEN ${GENERIC_SUBAGENT_NAME}
            ELSE COALESCE(adr.definition->'metadata'->>'name', adr.slug)
          END AS agent_name,
          conversation_preview.last_message_preview,
          ${exactUtcTimestampSql(sql`t.last_activity_at`)}
            AS last_activity_at_exact,
          ${exactUtcTimestampSql(sql`candidates.updated_at`)} AS updated_at_exact,
          ${threadActionRequiredSql({
            headRole: sql`head.role`,
            headStatus: sql`head.status`,
          })} AS action_required,
          COALESCE(tus.is_favorite, false) AS is_favorite
        FROM candidates
        JOIN threads t ON t.id = candidates.thread_id
        LEFT JOIN thread_works primary_tw
          ON primary_tw.thread_id = t.id AND primary_tw.is_primary = true
        LEFT JOIN works primary_work
          ON primary_work.id = primary_tw.work_id AND primary_work.deleted_at IS NULL
        LEFT JOIN thread_agent_bindings tab ON tab.thread_id = t.id
        LEFT JOIN agent_definition_revisions adr
          ON adr.id = tab.definition_revision_id
        LEFT JOIN thread_user_state tus
          ON tus.thread_id = t.id AND tus.user_id = ${input.userId}::uuid
        LEFT JOIN turns head ON head.id = t.conversational_leaf_turn_id
        LEFT JOIN ${projectChatPreviewLateral(sql`t.conversational_leaf_turn_id`)} ON true
        ORDER BY candidates.updated_at DESC, candidates.thread_id DESC
      `);
      return Array.from(rows as unknown as Iterable<WorkRow>).map(
        (row): WorkChatFeedRow => ({
          item: mapProjectChatRow(row),
          updatedAt: row.updated_at_exact,
        }),
      );
    },
  };
}
