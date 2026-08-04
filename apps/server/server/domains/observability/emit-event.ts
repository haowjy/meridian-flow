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
const SAFE_ERROR_CODES = new Set([
  "EACCES",
  "EADDRINUSE",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOENT",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
]);

function ownDataValue(value: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function safeErrorScalar(value: unknown): string | number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (
    typeof value === "string" &&
    value.length <= ERROR_SCALAR_MAX &&
    (/^[A-Z0-9]{5}$/.test(value) || SAFE_ERROR_CODES.has(value))
  ) {
    return value;
  }
  return undefined;
}

function safeErrorClass(error: Error): string {
  const name = ownDataValue(error, "name");
  return typeof name === "string" && SAFE_ERROR_CLASSES.has(name) ? name : "Error";
}

export function unknownToEventPayload(error: unknown): Record<string, unknown> {
  try {
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
  } catch {
    return { error: { class: "Error", category: "unexpected" } };
  }
  if (error instanceof Error) {
    const code = safeErrorScalar(ownDataValue(error, "code"));
    const rawStatus = ownDataValue(error, "status") ?? ownDataValue(error, "statusCode");
    const status =
      typeof rawStatus === "number" && Number.isFinite(rawStatus) ? rawStatus : undefined;
    const severity = ownDataValue(error, "severity");
    return {
      error: {
        class: safeErrorClass(error),
        category: severity === undefined ? "unexpected" : "database",
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
