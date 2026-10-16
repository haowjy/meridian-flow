/**
 * The one way a failure transition reaches the event log: `failure.recorded` when a failure is
 * classified, `failure.ended` when it ends. `./mf log --name failure.recorded` reads them.
 */
import type { FailureRecord } from "@meridian/contracts/failures";
import { emitEvent } from "./emit-event.js";
import type { EventSink } from "./ports/event-sink.js";

export function recordFailure(sink: EventSink, record: FailureRecord): void {
  emitEvent(sink, {
    level: record.failure.source === "bug" ? "error" : "warn",
    source: "failures",
    name: record.phase === "recorded" ? "failure.recorded" : "failure.ended",
    correlation: {
      threadId: record.threadId,
      ...(record.turnId ? { turnId: record.turnId } : {}),
    },
    payload: {
      occurrenceId: record.occurrenceId,
      category: record.failure.category,
      source: record.failure.source,
      actionable: record.failure.actionable,
      failureCode: record.failure.cause.code,
      ...(record.failure.cause.reason ? { failureReason: record.failure.cause.reason } : {}),
      ...(record.failure.cause.status !== undefined
        ? { providerStatus: record.failure.cause.status }
        : {}),
      ...(record.executionId ? { executionId: record.executionId } : {}),
      ...(record.phase === "ended"
        ? { end: record.end, ...(record.byTurnId ? { byTurnId: record.byTurnId } : {}) }
        : {}),
    },
  });
}
