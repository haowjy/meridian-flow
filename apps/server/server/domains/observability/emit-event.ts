/**
 * EventSink call-site helpers: timestamp stamping and JSON-natural error payloads
 * for observability records. Keeps emit shape consistent across domain migrations.
 */
import { isMeridianError } from "@meridian/contracts/interrupt";
import type { EventRecord, EventSink } from "./ports/event-sink.js";

const ERROR_SCALAR_MAX = 128;

function safeErrorScalar(value: unknown): string | number | boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") return value.slice(0, ERROR_SCALAR_MAX);
  return undefined;
}

export function unknownToEventPayload(error: unknown): Record<string, unknown> {
  if (isMeridianError(error)) {
    return {
      error: {
        class: "MeridianError",
        category: error.source,
        code: error.code.slice(0, ERROR_SCALAR_MAX),
        retryable: error.retryable,
      },
    };
  }
  if (error instanceof Error) {
    const candidate = error as Error & Record<string, unknown>;
    const code = safeErrorScalar(candidate.code);
    const status = safeErrorScalar(candidate.status ?? candidate.statusCode);
    return {
      error: {
        class: error.name.slice(0, ERROR_SCALAR_MAX),
        category: candidate.severity === undefined ? "unexpected" : "database",
        ...(code !== undefined && { code }),
        ...(status !== undefined && { status }),
      },
    };
  }
  return { error: { class: typeof error, category: "unexpected" } };
}

export function emitEvent(
  sink: EventSink,
  event: Omit<EventRecord, "timestamp"> & { timestamp?: string },
): void {
  sink.emit({
    ...event,
    eventId: event.eventId ?? crypto.randomUUID(),
    timestamp: event.timestamp ?? new Date().toISOString(),
  });
}
