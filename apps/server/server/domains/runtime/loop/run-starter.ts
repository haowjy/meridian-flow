/** Best-effort wake owner: benign contention is quiet; failed starts are correlated once. */
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import { TurnStartConflictError } from "../../threads/index.js";
import type { RunStarter } from "./ports.js";
import type { TurnRunner } from "./run-session.js";

export function createRunStarter(
  runner: Pick<TurnRunner, "startDrain">,
  eventSink: EventSink,
): RunStarter {
  return {
    async start(threadId) {
      try {
        await runner.startDrain(threadId);
      } catch (error) {
        if (error instanceof TurnStartConflictError) return;
        emitEvent(eventSink, {
          level: "warn",
          source: "runtime.wake",
          name: "wake.failed",
          correlation: { threadId },
          payload: unknownToEventPayload(error),
        });
      }
    },
  };
}
