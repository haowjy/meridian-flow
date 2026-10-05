/** Best-effort guard for model-request debug writes: a failed write warns and never changes the run. */
import {
  type EventCorrelation,
  type EventSink,
  emitEvent,
  unknownToEventPayload,
} from "../../observability/index.js";

export function guardDebugCapture(
  eventSink: EventSink,
  event: { source: string; correlation: EventCorrelation },
  write: () => void,
): void {
  try {
    write();
  } catch (cause) {
    emitEvent(eventSink, {
      level: "warn",
      source: event.source,
      name: "model_request_debug.capture_failed",
      correlation: event.correlation,
      payload: unknownToEventPayload(cause),
    });
  }
}
