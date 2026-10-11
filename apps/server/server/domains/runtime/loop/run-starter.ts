/**
 * Best-effort wake owner: benign contention is quiet; failed starts are
 * correlated once. Due write-mode switches apply before the run starts, so
 * the release wake, the sweep and enqueue wakes all reach them.
 */
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import { TurnStartConflictError } from "../../threads/index.js";
import type { RunStarter } from "./ports.js";
import type { TurnRunner } from "./run-session.js";
import type { RuntimeDelivery } from "./runtime-delivery.js";

export function createRunStarter(
  runner: Pick<TurnRunner, "startDrain"> & Pick<RuntimeDelivery, "applyDueSwitches">,
  eventSink: EventSink,
): RunStarter {
  return {
    async start(threadId) {
      try {
        await runner.applyDueSwitches(threadId);
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
