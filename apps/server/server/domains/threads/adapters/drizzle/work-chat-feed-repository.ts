/** Bounded Work-associated Project-chat projection with current primary-Work identity. */
import { sql } from "drizzle-orm";
import type { WorkChatFeedRepository, WorkChatFeedRow } from "../../ports/repositories.js";
import { currentDrizzleDb, type DrizzleDatabase } from "./repositories.js";
import {
  exactUtcTimestampSql,
  mapProjectChatRow,
  type ProjectChatSqlRow,
  projectChatPreviewLateral,
  threadActionRequiredSql,
  visibleConversationalHeadLateral,
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
          conversation_preview.last_message_preview,
          ${exactUtcTimestampSql(sql`COALESCE(conversational_head.activity_at, t.created_at)`)}
            AS last_activity_at_exact,
          ${exactUtcTimestampSql(sql`candidates.updated_at`)} AS updated_at_exact,
          ${threadActionRequiredSql({
            headRole: sql`conversational_head.role`,
            headStatus: sql`conversational_head.status`,
          })} AS action_required,
          COALESCE(tus.is_favorite, false) AS is_favorite
        FROM candidates
        JOIN threads t ON t.id = candidates.thread_id
        LEFT JOIN thread_works primary_tw
          ON primary_tw.thread_id = t.id AND primary_tw.is_primary = true
        LEFT JOIN works primary_work
          ON primary_work.id = primary_tw.work_id AND primary_work.deleted_at IS NULL
        LEFT JOIN thread_user_state tus
          ON tus.thread_id = t.id AND tus.user_id = ${input.userId}::uuid
        LEFT JOIN ${visibleConversationalHeadLateral(sql`t.active_leaf_turn_id`)} ON true
        LEFT JOIN ${projectChatPreviewLateral(sql`conversational_head.turn_id`)} ON true
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
