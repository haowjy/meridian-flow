/** Pending undo notifications bridge user reversals to the next LLM turn. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";

export type UndoNotificationDirection = "undo" | "redo";

export interface PendingUndoNotification {
  id: number;
  threadId: ThreadId;
  writeHandle: string;
  turnId: TurnId;
  uri: string;
  direction: UndoNotificationDirection;
  sweptContent: boolean;
  beforeContentRef: number | null;
  createdAt: Date;
}

export interface PendingUndoNotificationRepository {
  record(input: {
    threadId: string;
    writeHandles: string[];
    writeHandleTurns: readonly { writeHandle: string; turnId: string }[];
    uri: string;
    direction: UndoNotificationDirection;
    sweptContent: boolean;
    beforeContentRef: number | null;
  }): Promise<void>;
  consumeForThread(threadId: string): Promise<PendingUndoNotification[]>;
}

export function coalescePendingUndoNotifications(
  notifications: readonly PendingUndoNotification[],
): PendingUndoNotification[] {
  const byDocumentWrite = new Map<string, PendingUndoNotification>();
  for (const notification of notifications) {
    byDocumentWrite.set(`${notification.uri}::${notification.writeHandle}`, notification);
  }
  return [...byDocumentWrite.values()].filter((notification) => notification.direction === "undo");
}

export { createDrizzlePendingUndoNotificationRepository } from "./adapters/drizzle-pending-undo-notification-repository.js";
