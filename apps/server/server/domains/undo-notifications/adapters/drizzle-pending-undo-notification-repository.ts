/** Drizzle repository for pending undo notifications consumed by runtime turns. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { pendingUndoNotifications } from "@meridian/database/schema";
import { asc, eq } from "drizzle-orm";
import type { PendingUndoNotification, PendingUndoNotificationRepository } from "../index.js";

type DrizzlePendingUndoDb = Pick<Database, "insert" | "select" | "delete" | "transaction">;

export function createDrizzlePendingUndoNotificationRepository(
  db: DrizzlePendingUndoDb,
): PendingUndoNotificationRepository {
  return {
    async record(input) {
      if (input.writeHandles.length === 0) return;
      await db.insert(pendingUndoNotifications).values(
        input.writeHandles.map((writeHandle) => ({
          threadId: input.threadId as ThreadId,
          writeHandle,
          turnId: input.turnId as TurnId,
          uri: input.uri,
          direction: input.direction,
        })),
      );
    },
    async consumeForThread(threadId) {
      return db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(pendingUndoNotifications)
          .where(eq(pendingUndoNotifications.threadId, threadId as ThreadId))
          .orderBy(asc(pendingUndoNotifications.createdAt), asc(pendingUndoNotifications.id));
        if (rows.length === 0) return [];
        await tx
          .delete(pendingUndoNotifications)
          .where(eq(pendingUndoNotifications.threadId, threadId as ThreadId));
        return rows.map(mapRow);
      });
    },
  };
}

type PendingUndoRow = typeof pendingUndoNotifications.$inferSelect;

function mapRow(row: PendingUndoRow): PendingUndoNotification {
  return {
    id: row.id,
    threadId: row.threadId,
    writeHandle: row.writeHandle,
    turnId: row.turnId,
    uri: row.uri,
    direction: row.direction,
    createdAt: row.createdAt,
  };
}
