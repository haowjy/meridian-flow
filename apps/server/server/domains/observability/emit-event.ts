/**
 * EventSink call-site helpers: timestamp stamping and JSON-natural error payloads
 * for observability records. Keeps emit shape consistent across domain migrations.
 */
import { isMeridianError } from "@meridian/contracts/interrupt";
import type { EventRecord, EventSink } from "./ports/event-sink.js";

const ERROR_SCALAR_MAX = 128;
const SAFE_ERROR_CLASSES = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "URIError",
  "EvalError",
  "AggregateError",
]);
const STABLE_ERROR_CODE = /^(?:[A-Z0-9]{5}|E[A-Z0-9_]{1,63}|ERR_[A-Z0-9_]{1,59})$/;

function safeErrorScalar(value: unknown): string | number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (
    typeof value === "string" &&
    value.length <= ERROR_SCALAR_MAX &&
    STABLE_ERROR_CODE.test(value)
  ) {
    return value;
  }
  return undefined;
}

function safeErrorClass(error: Error): string {
  return typeof error.name === "string" && SAFE_ERROR_CLASSES.has(error.name)
    ? error.name
    : "Error";
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
    const rawStatus = candidate.status ?? candidate.statusCode;
    const status =
      typeof rawStatus === "number" && Number.isFinite(rawStatus) ? rawStatus : undefined;
    return {
      error: {
        class: safeErrorClass(error),
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
