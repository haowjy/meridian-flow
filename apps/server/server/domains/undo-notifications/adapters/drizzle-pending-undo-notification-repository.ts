/** Drizzle repository for pending undo notifications consumed by runtime turns. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { pendingUndoNotifications } from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import type { PendingUndoNotification, PendingUndoNotificationRepository } from "../index.js";

type DrizzlePendingUndoDb = Pick<Database, "insert" | "delete">;

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
      const rows = await db
        .delete(pendingUndoNotifications)
        .where(eq(pendingUndoNotifications.threadId, threadId as ThreadId))
        .returning();
      return rows.sort(comparePendingUndoRows).map(mapRow);
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

function comparePendingUndoRows(left: PendingUndoRow, right: PendingUndoRow): number {
  const createdAt = left.createdAt.getTime() - right.createdAt.getTime();
  if (createdAt !== 0) return createdAt;
  return left.id.localeCompare(right.id);
}
