/** Project-chat feed: primary chats ranked by stored conversational activity. */
import { sql } from "drizzle-orm";
import type { ProjectChatFeedRepository } from "../../ports/repositories.js";
import { currentDrizzleDb, type DrizzleDatabase } from "./repositories.js";
import {
  chatFeedRowsSql,
  mapProjectChatRow,
  type ProjectChatSqlRow,
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
      const candidates = sql`
        SELECT t.id AS thread_id
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
      `;
      const rows = await currentDrizzleDb(db).execute(
        chatFeedRowsSql({ candidates, userId: input.userId }),
      );
      return Array.from(rows as unknown as Iterable<ProjectChatSqlRow>).map(mapProjectChatRow);
    },
  };
}
