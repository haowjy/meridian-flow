/** Drizzle repository for pending undo notifications consumed by runtime turns. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { pendingUndoNotifications } from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import {
  coalescePendingUndoNotifications,
  type PendingUndoNotification,
  type PendingUndoNotificationRepository,
} from "../index.js";

type DrizzlePendingUndoDb = Pick<Database, "insert" | "delete">;

export function createDrizzlePendingUndoNotificationRepository(
  db: DrizzlePendingUndoDb,
): PendingUndoNotificationRepository {
  return {
    async record(input) {
      if (input.writeHandles.length === 0) return;
      const turnByHandle = turnByWriteHandle(input.writeHandleTurns);
      await db.insert(pendingUndoNotifications).values(
        input.writeHandles.map((writeHandle) => ({
          threadId: input.threadId as ThreadId,
          writeHandle,
          turnId: requireTurnId(writeHandle, turnByHandle) as TurnId,
          uri: input.uri,
          direction: input.direction,
          sweptContent: input.sweptContent,
          beforeContentRef: input.beforeContentRef,
        })),
      );
    },
    async consumeForThread(threadId) {
      const rows = await db
        .delete(pendingUndoNotifications)
        .where(eq(pendingUndoNotifications.threadId, threadId as ThreadId))
        .returning();
      return coalescePendingUndoNotifications(rows.sort(comparePendingUndoRows).map(mapRow));
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
    sweptContent: row.sweptContent,
    beforeContentRef: row.beforeContentRef,
    createdAt: row.createdAt,
  };
}

function comparePendingUndoRows(left: PendingUndoRow, right: PendingUndoRow): number {
  const createdAt = left.createdAt.getTime() - right.createdAt.getTime();
  if (createdAt !== 0) return createdAt;
  return left.id - right.id;
}

function turnByWriteHandle(
  writeHandleTurns: readonly { writeHandle: string; turnId: string }[],
): ReadonlyMap<string, string> {
  return new Map(writeHandleTurns.map((entry) => [entry.writeHandle, entry.turnId]));
}

function requireTurnId(writeHandle: string, turns: ReadonlyMap<string, string>): string {
  const turnId = turns.get(writeHandle);
  if (!turnId) throw new Error(`missing undo notification turn for ${writeHandle}`);
  return turnId;
}
