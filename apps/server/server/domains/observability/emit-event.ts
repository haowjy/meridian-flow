/**
 * EventSink call-site helpers: timestamp stamping and JSON-natural error payloads
 * for observability records. Keeps emit shape consistent across domain migrations.
 */
import { isMeridianError, meridianErrorToJson } from "@meridian/contracts/interrupt";
import type { EventRecord, EventSink } from "./ports/event-sink.js";

export function unknownToEventPayload(error: unknown): Record<string, unknown> {
  if (isMeridianError(error)) {
    return { error: meridianErrorToJson(error) };
  }
  if (error instanceof Error) {
    const payload: Record<string, unknown> = {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
    if (error.cause !== undefined) {
      payload.cause = unknownToEventPayload(error.cause);
    }
    return payload;
  }
  return { error };
}

export function emitEvent(
  sink: EventSink,
  event: Omit<EventRecord, "timestamp"> & { timestamp?: string },
): void {
  sink.emit({
    ...event,
    timestamp: event.timestamp ?? new Date().toISOString(),
  });
}
