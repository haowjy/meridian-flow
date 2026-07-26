/** Drizzle-backed destructive delivery queue for model-context notices. */
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

    async drainForModelContext(threadId) {
      return runInDrizzleTransaction(db, async () => {
        const tx = currentDrizzleDb(db);
        const rows = await tx
          .select()
          .from(pendingNotices)
          .where(eq(pendingNotices.threadId, threadId))
          .orderBy(asc(pendingNotices.createdAt), asc(pendingNotices.id));
        if (rows.length === 0) return [];
        await tx.delete(pendingNotices).where(
          inArray(
            pendingNotices.id,
            rows.map(({ id }) => id),
          ),
        );
        return rows.map(mapNotice);
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
