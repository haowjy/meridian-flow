/** Fair, bounded recovery of pending messages. The caller retains the returned keyset cursor. */
import type { ThreadId } from "@meridian/contracts/runtime";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import { TurnStartConflictError } from "../../threads/index.js";
import type { Inbox, RunAuthority, RunStarter } from "./ports.js";

export async function sweepWakes(input: {
  inbox: Pick<Inbox, "pendingMessageThreads">;
  authority: Pick<RunAuthority, "readMany">;
  runStarter: RunStarter;
  eventSink: EventSink;
  refreshPending?: (threadId: ThreadId) => Promise<void>;
  limit: number;
  afterThreadId?: ThreadId;
}): Promise<ThreadId | undefined> {
  let threadIds = await input.inbox.pendingMessageThreads(input.limit, input.afterThreadId);
  if (threadIds.length === 0 && input.afterThreadId) {
    threadIds = await input.inbox.pendingMessageThreads(input.limit);
  }
  const live = await input.authority.readMany(threadIds);
  for (let offset = 0; offset < threadIds.length; offset += 4) {
    await Promise.all(
      threadIds.slice(offset, offset + 4).map(async (threadId) => {
        if (live.has(threadId)) return;
        try {
          await input.runStarter.start(threadId);
        } catch (error) {
          if (!(error instanceof TurnStartConflictError)) reportFailure(threadId, error);
        }
        // Refresh from the authoritative projection whether the start won, lost,
        // or failed. No per-candidate holder reads (or holder-read failure holes).
        try {
          await input.refreshPending?.(threadId);
        } catch (error) {
          reportFailure(threadId, error);
        }
      }),
    );
  }
  return threadIds.at(-1);

  function reportFailure(threadId: ThreadId, error: unknown) {
    emitEvent(input.eventSink, {
      level: "warn",
      source: "runtime.wake",
      name: "wake.failed",
      correlation: { threadId },
      payload: unknownToEventPayload(error),
    });
  }
}
