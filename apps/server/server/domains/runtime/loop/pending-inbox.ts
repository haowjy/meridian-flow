/** Read-only pending inbox projection. Mutation publication belongs to RuntimeDelivery. */
import type { ThreadId } from "@meridian/contracts/runtime";
import type { PendingInboxItem, ThreadPendingInbox } from "@meridian/contracts/threads";
import { inboxMessageText } from "./inbox-context.js";
import type { InboxMessage, InboxReader } from "./ports.js";

/** Project all pending provenance into the shared read model, preserving `seq` order. */
export type PendingInboxRun = { turnId: string | null; messageIds: readonly string[] } | null;

/** Classify from one canonical lease/assistant snapshot, not admission-time hints. */
export function projectPendingInbox(
  messages: readonly InboxMessage[],
  run: PendingInboxRun = null,
): ThreadPendingInbox {
  return {
    items: messages.map((message): PendingInboxItem => {
      const deliveryState =
        run === null || run.turnId === null
          ? "awaiting_run"
          : run.messageIds.includes(message.id)
            ? "awaiting_run"
            : "waiting";
      return {
        id: message.id,
        seq: message.seq,
        intent: message.intent,
        provenance: message.provenance,
        deliveryState,
        summary: inboxMessageText(message),
        enqueuedAt: message.enqueuedAt,
      };
    }),
  };
}

export async function readPendingInbox(
  inbox: Pick<InboxReader, "readPendingProjection">,
  threadId: ThreadId,
): Promise<ThreadPendingInbox> {
  const projection = await inbox.readPendingProjection(threadId);
  return projectPendingInbox(projection.messages, projection.run);
}
