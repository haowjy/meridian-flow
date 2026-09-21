/**
 * The pending-inbox read model and its live signal.
 *
 * `projectPendingInbox` is the one transform from durable inbox rows to the
 * writer-facing `ThreadPendingInbox` (design §5). `createNotifyingThreadedInbox`
 * decorates the producer's locked enqueue with a best-effort `inbox.changed`
 * append after the caller's transaction commits, so a queued message is visible
 * before delivery; the orchestrator appends the same event inside the ack
 * transaction. Enqueue-time emission is the primary path here, not the
 * focus/refresh fallback the design names.
 */
import type { ThreadId } from "@meridian/contracts/runtime";
import type {
  OrchestratorEvent,
  PendingInboxItem,
  ThreadPendingInbox,
} from "@meridian/contracts/threads";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import type { EventJournalWriter } from "../../threads/index.js";
import { inboxMessageText } from "./inbox-context.js";
import type { InboxMessage } from "./ports.js";
import type { ThreadedInbox } from "./threaded-inbox.js";

/** Project durable inbox rows into the pending tray's shape, preserving `seq` order. */
export function projectPendingInbox(messages: readonly InboxMessage[]): ThreadPendingInbox {
  return {
    items: messages.map(
      (message): PendingInboxItem => ({
        id: message.id,
        seq: message.seq,
        intent: message.intent,
        provenance: message.provenance,
        summary: inboxMessageText(message),
        enqueuedAt: message.enqueuedAt,
      }),
    ),
  };
}

/**
 * The `inbox.changed` fact for the current pending rows. The orchestrator folds
 * this into the ack transaction's event list; the enqueue path appends it after
 * commit.
 */
export function pendingInboxChangedEvent(
  threadId: ThreadId,
  messages: readonly InboxMessage[],
): OrchestratorEvent {
  return {
    type: "inbox.changed",
    threadId,
    pending: projectPendingInbox(messages),
  };
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
 * pending row. Appends are serialized per thread within this process: the read
 * happens inside the serialized task, so a later task's read sees every earlier
 * commit and its full-replace frame cannot be overtaken by an older one. The ack
 * path is ordered by its own transaction; a rare in-process interleaving of an
 * enqueue append after an ack append self-heals on the next subscribe.
 */
export function createNotifyingThreadedInbox(deps: {
  threadedInbox: ThreadedInbox;
  eventWriter: EventJournalWriter;
  readPending: (threadId: ThreadId) => Promise<ThreadPendingInbox>;
  schedulePostCommit(task: () => Promise<void>): void;
  eventSink: EventSink;
}): ThreadedInbox {
  const chains = new Map<ThreadId, Promise<void>>();

  function appendAfterCommit(threadId: ThreadId): void {
    deps.schedulePostCommit(async () => {
      const previous = chains.get(threadId) ?? Promise.resolve();
      const next = previous.then(() =>
        appendPendingInboxChangeBestEffort({
          eventWriter: deps.eventWriter,
          readPending: deps.readPending,
          threadId,
          eventSink: deps.eventSink,
        }),
      );
      chains.set(threadId, next);
      await next;
      if (chains.get(threadId) === next) chains.delete(threadId);
    });
  }

  return {
    async enqueue(draft) {
      const message = await deps.threadedInbox.enqueue(draft);
      appendAfterCommit(draft.threadId);
      return message;
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
