/** Drizzle-backed storage for model-context notices with ID-based consumption. */
import type { Database } from "@meridian/database";
import { pendingNotices } from "@meridian/database/schema";
import { asc, eq, inArray } from "drizzle-orm";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import type { Notice, NoticePort } from "../index.js";

export function createDrizzleNoticePort(db: Database): NoticePort {
  return {
    async record(input) {
      await runInDrizzleTransaction(db, async () => {
        const tx = currentDrizzleDb(db);
        const [row] = await tx
          .insert(pendingNotices)
          .values({
            kind: input.kind,
            threadId: input.scope.threadId,
            message: input.message,
            data: input.data,
          })
          .returning({ id: pendingNotices.id });
        if (!row) throw new Error("Failed to record model-context notice");
      });
    },

    async peek(threadId) {
      const rows = await currentDrizzleDb(db)
        .select()
        .from(pendingNotices)
        .where(eq(pendingNotices.threadId, threadId))
        .orderBy(asc(pendingNotices.createdAt), asc(pendingNotices.id));
      return rows.map(mapNotice);
    },

    async consume(ids) {
      if (ids.length === 0) return;
      await runInDrizzleTransaction(db, async () => {
        await currentDrizzleDb(db)
          .delete(pendingNotices)
          .where(inArray(pendingNotices.id, [...ids]));
      });
    },
  };
}

type PendingNoticeRow = typeof pendingNotices.$inferSelect;

function mapNotice(row: PendingNoticeRow): Notice {
  return {
    id: row.id,
    kind: row.kind,
    scope: { kind: "thread", threadId: row.threadId },
    message: row.message,
    data: row.data,
    createdAt: row.createdAt,
  };
}
