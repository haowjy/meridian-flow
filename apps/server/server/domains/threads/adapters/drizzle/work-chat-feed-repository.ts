/** Bounded Work-associated Project-chat projection with current primary-Work identity. */
import { sql } from "drizzle-orm";
import type { WorkChatFeedRepository } from "../../ports/repositories.js";
import { currentDrizzleDb, type DrizzleDatabase } from "./repositories.js";
import {
  chatFeedRowsSql,
  mapProjectChatRow,
  type ProjectChatSqlRow,
} from "./visible-conversation-sql.js";
import { workAssociationCandidatesSql } from "./work-association-candidates-sql.js";

export function createDrizzleWorkChatFeedRepository(db: DrizzleDatabase): WorkChatFeedRepository {
  return {
    async queryPage(input) {
      const candidates = workAssociationCandidatesSql({
        projectId: input.projectId,
        workId: input.workId,
        sortColumn: sql`t.last_activity_at`,
        afterSortAt: input.after?.sortAt ?? null,
        afterThreadId: input.after?.threadId ?? null,
        limit: input.limit,
      });
      const rows = await currentDrizzleDb(db).execute(
        chatFeedRowsSql({ candidates, userId: input.userId }),
      );
      return Array.from(rows as unknown as Iterable<ProjectChatSqlRow>).map(mapProjectChatRow);
    },
  };
}
