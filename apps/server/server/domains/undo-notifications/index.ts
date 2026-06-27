/** Pending undo notifications bridge user reversals to the next LLM turn. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";

export type UndoNotificationDirection = "undo" | "redo";

export interface PendingUndoNotification {
  id: string;
  threadId: ThreadId;
  writeHandle: string;
  turnId: TurnId;
  uri: string;
  direction: UndoNotificationDirection;
  createdAt: Date;
}

export interface PendingUndoNotificationRepository {
  record(input: {
    threadId: string;
    writeHandles: string[];
    turnId: string;
    uri: string;
    direction: UndoNotificationDirection;
  }): Promise<void>;
  consumeForThread(threadId: string): Promise<PendingUndoNotification[]>;
}

export function coalesceUndoNotifications(
  notifications: readonly PendingUndoNotification[],
): PendingUndoNotification[] {
  const byWrite = new Map<string, PendingUndoNotification>();
  for (const notification of notifications) {
    byWrite.set(notification.writeHandle, notification);
  }
  return [...byWrite.values()].filter((notification) => notification.direction === "undo");
}

export { createDrizzlePendingUndoNotificationRepository } from "./adapters/drizzle-pending-undo-notification-repository.js";
