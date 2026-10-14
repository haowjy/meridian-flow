/** Read-only pending inbox projection. Mutation publication belongs to RuntimeDelivery. */
import type { ThreadId } from "@meridian/contracts/runtime";
import type { PendingInboxItem, ThreadPendingInbox } from "@meridian/contracts/threads";
import { inboxMessageText } from "./inbox-context.js";
import type { InboxMessage, InboxReader } from "./ports.js";

/** Project all pending provenance into the shared read model, preserving `seq` order. */
export type PendingInboxRun = { turnId: string | null; messageIds: readonly string[] } | null;

/** `waiting` once a bound turn exists that has not adopted the row; otherwise `awaiting_run`. */
export function classifyDelivery(
  messageId: string,
  run: PendingInboxRun,
): PendingInboxItem["deliveryState"] {
  if (run === null || run.turnId === null) return "awaiting_run";
  return run.messageIds.includes(messageId) ? "awaiting_run" : "waiting";
}

export function pendingInboxItem(
  message: InboxMessage,
  deliveryState: PendingInboxItem["deliveryState"],
): PendingInboxItem {
  return {
    id: message.id,
    seq: message.seq,
    intent: message.intent,
    ...(message.body.kind === "compact" || message.body.kind === "write_mode"
      ? { control: message.body }
      : {}),
    provenance: message.provenance,
    deliveryState,
    summary: inboxMessageText(message),
    enqueuedAt: message.enqueuedAt,
  };
}

/** Classify from one canonical lease/assistant snapshot, not admission-time hints. */
export function projectPendingInbox(
  messages: readonly InboxMessage[],
  run: PendingInboxRun = null,
  blocked?: ThreadPendingInbox["blocked"],
): ThreadPendingInbox {
  return {
    ...(blocked &&
    messages.some((message) => message.intent === "message" || message.intent === "control")
      ? { blocked }
      : {}),
    items: messages
      .filter((message) => message.body.kind !== "work_context_refresh")
      .map((message) => pendingInboxItem(message, classifyDelivery(message.id, run))),
  };
}

export async function readPendingInbox(
  inbox: Pick<InboxReader, "readPendingProjection">,
  threadId: ThreadId,
): Promise<ThreadPendingInbox> {
  const projection = await inbox.readPendingProjection(threadId);
  return projectPendingInbox(projection.messages, projection.run, projection.blocked);
}
