/** Fair, bounded recovery of pending messages. The caller retains the returned keyset cursor. */
import type { ThreadId } from "@meridian/contracts/runtime";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import { TurnStartConflictError } from "../../threads/index.js";
import type { RunClaim, RunStarter } from "./ports.js";

export async function sweepWakes(input: {
  delivery: Pick<
    import("./runtime-delivery.js").RuntimeDelivery,
    "pendingMessageThreads" | "refreshPending"
  >;
  authority: Pick<RunClaim, "readMany">;
  runStarter: RunStarter;
  eventSink: EventSink;
  limit: number;
  afterThreadId?: ThreadId;
}): Promise<{ cursor: ThreadId | undefined; count: number }> {
  let threadIds = await input.delivery.pendingMessageThreads(input.limit, input.afterThreadId);
  if (threadIds.length === 0 && input.afterThreadId) {
    threadIds = await input.delivery.pendingMessageThreads(input.limit);
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
        try {
          await input.delivery.refreshPending(threadId);
        } catch (error) {
          reportFailure(threadId, error);
        }
      }),
    );
  }
  return { cursor: threadIds.at(-1), count: threadIds.length };

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
