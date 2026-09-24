/**
 * The pending-inbox read model and its live signal.
 *
 * `projectPendingInbox` is the one transform from every durable inbox row to
 * the generic `ThreadPendingInbox` (design §6). Writer-only filtering belongs
 * to the chat selector, not this shared projection. `createNotifyingThreadedInbox`
 * decorates the producer's locked enqueue with a best-effort `inbox.changed`
 * append after the caller's transaction commits, so a queued message is visible
 * before delivery; the orchestrator appends the same event inside the ack
 * transaction. Enqueue-time emission is the primary path here, not the
 * focus/refresh fallback the design names.
 */
import type { ThreadId } from "@meridian/contracts/runtime";
import type { PendingInboxItem, ThreadPendingInbox } from "@meridian/contracts/threads";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import type { EventJournalWriter } from "../../threads/index.js";
import { inboxMessageText } from "./inbox-context.js";
import type { Inbox, InboxMessage } from "./ports.js";
import type { ThreadedInbox } from "./threaded-inbox.js";

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
            ? "consuming"
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
  inbox: Inbox,
  threadId: ThreadId,
): Promise<ThreadPendingInbox> {
  const projection = await inbox.readPendingProjection(threadId);
  return projectPendingInbox(projection.messages, projection.run);
}

async function appendPendingInboxChange(input: {
  eventWriter: EventJournalWriter;
  readPending: (threadId: ThreadId) => Promise<ThreadPendingInbox>;
  threadId: ThreadId;
}): Promise<void> {
  const pending = await input.readPending(input.threadId);
  await input.eventWriter.appendEvent(input.threadId, {
    type: "inbox.changed",
    threadId: input.threadId,
    pending,
  });
}

/**
 * Wrap the producer-facing enqueue so a committed insert announces the new
 * pending row. The shared thread lock serializes its read-and-append with ack,
 * adoption, release, and other producers across this process and other servers.
 */
export function createNotifyingThreadedInbox(deps: {
  threadedInbox: ThreadedInbox;
  eventWriter: EventJournalWriter;
  readPending: (threadId: ThreadId) => Promise<ThreadPendingInbox>;
  schedulePostCommit(task: () => Promise<void>): void;
  eventSink: EventSink;
}): ThreadedInbox {
  function appendAfterCommit(threadId: ThreadId): void {
    deps.schedulePostCommit(async () => {
      await deps.threadedInbox
        .withThreadLock(threadId, async () => {
          await appendPendingInboxChangeBestEffort({
            eventWriter: deps.eventWriter,
            readPending: deps.readPending,
            threadId,
            eventSink: deps.eventSink,
          });
        })
        .catch((error) =>
          emitEvent(deps.eventSink, {
            level: "warn",
            source: "runtime.inbox",
            name: "inbox.changed.append_failed",
            correlation: { threadId },
            payload: { threadId, ...unknownToEventPayload(error) },
          }),
        );
    });
  }

  return {
    async enqueue(draft) {
      const message = await deps.threadedInbox.enqueue(draft);
      appendAfterCommit(draft.threadId);
      return message;
    },
    withThreadLock(threadId, operation) {
      return deps.threadedInbox.withThreadLock(threadId, (producer) =>
        operation({
          async enqueue(draft) {
            const message = await producer.enqueue(draft);
            appendAfterCommit(draft.threadId);
            return message;
          },
        }),
      );
    },
  };
}

/**
 * The live signal is a side effect of the enqueue, not part of the durable
 * write: a failed read or append is reported and swallowed so it can never fail
 * the producer. The row itself is durable and the snapshot recomputes `pending`.
 */
async function appendPendingInboxChangeBestEffort(input: {
  eventWriter: EventJournalWriter;
  readPending: (threadId: ThreadId) => Promise<ThreadPendingInbox>;
  threadId: ThreadId;
  eventSink: EventSink;
}): Promise<void> {
  try {
    await appendPendingInboxChange(input);
  } catch (error) {
    emitEvent(input.eventSink, {
      level: "warn",
      source: "runtime.inbox",
      name: "inbox.changed.append_failed",
      correlation: { threadId: input.threadId },
      payload: { threadId: input.threadId, ...unknownToEventPayload(error) },
    });
  }
}
