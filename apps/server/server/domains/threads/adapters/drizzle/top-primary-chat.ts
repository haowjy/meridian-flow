import type { ThreadId } from "@meridian/contracts/runtime";
import { sql } from "drizzle-orm";
import { currentDrizzleDb, type DrizzleDatabase } from "../../../../shared/drizzle-transaction.js";
import type { TopPrimaryChat, TopPrimaryChatResolver } from "../../ports/top-primary-chat.js";

export function createDrizzleTopPrimaryChatResolver(db: DrizzleDatabase): TopPrimaryChatResolver {
  return {
    async resolveTopPrimaryChat(threadId: ThreadId): Promise<TopPrimaryChat | null> {
      const rows = await currentDrizzleDb(db).execute<{ id: ThreadId; ref: string | null }>(sql`
        WITH RECURSIVE chain AS (
          SELECT id, ref, kind, parent_thread_id, 0 AS depth FROM threads WHERE id = ${threadId}
          UNION ALL
          SELECT t.id, t.ref, t.kind, t.parent_thread_id, chain.depth + 1
          FROM threads t JOIN chain ON t.id = chain.parent_thread_id
          WHERE chain.kind <> 'primary' AND chain.depth < 32
        )
        SELECT id, ref FROM chain WHERE kind = 'primary' LIMIT 1
      `);
      const row = rows[0];
      return row?.ref ? { chatId: row.id, chatRef: row.ref } : null;
    },
  };
}
