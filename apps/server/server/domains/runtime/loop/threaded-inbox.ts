/**
 * The one producer-facing enqueue path for the durable inbox.
 *
 * `Inbox.enqueue` is raw storage: it does not serialize with the run's final
 * claim, so a producer that calls it directly can commit a message after the
 * draining run's `closeRun` final claim and strand it, and two concurrent
 * inserts on one thread can commit out of `seq` order. This module wraps the
 * raw `Inbox` in the per-thread lock that `closeRun` also takes, so the insert
 * commits before the final claim's empty-check and cannot interleave.
 *
 * For a directed `message` it schedules a best-effort `RunStarter.start` after the caller's
 * transaction commits. Scheduling after commit matters because the child driver
 * enqueues its terminal report inside its own transaction; an inline wake would
 * resolve that still-open transaction and fail. The durable guarantee is the
 * wake sweep, not this call.
 *
 * Producers get this port, never the raw `Inbox`. The drain and `closeRun`
 * keep the raw `Inbox` and the `ThreadLock`; they are the consumer side.
 */
import type { Inbox, InboxMessage, MessageDraft, RunStarter } from "./ports.js";
import type { ThreadLock } from "./thread-lock.js";

export interface ThreadedInbox {
  enqueue(draft: MessageDraft): Promise<InboxMessage>;
}

export function createThreadedInbox(deps: {
  inbox: Inbox;
  threadLock: ThreadLock;
  runStarter: RunStarter;
  /** Schedule a non-blocking wake after the caller's business transaction commits. */
  schedulePostCommit(task: () => Promise<void>): void;
}): ThreadedInbox {
  return {
    async enqueue(draft) {
      const message = await deps.threadLock.withThreadLock(draft.threadId, () =>
        deps.inbox.enqueue(draft),
      );
      if (draft.intent === "message") {
        deps.schedulePostCommit(async () => {
          await deps.runStarter.start(draft.threadId).catch(() => undefined);
        });
      }
      return message;
    },
  };
}
