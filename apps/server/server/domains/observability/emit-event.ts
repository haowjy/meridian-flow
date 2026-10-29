/**
 * EventSink call-site helpers: timestamp stamping and JSON-natural error payloads
 * for observability records. Keeps emit shape consistent across domain migrations.
 */
import { isMeridianError } from "@meridian/contracts/errors";
import type { EventRecord, EventSink } from "./ports/event-sink.js";
import { safeMeridianErrorCode } from "./safe-event.js";

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

/** Comma-joins at most three ids so the list fits one bounded correlation value. */
export function joinIds(ids: readonly string[]): string {
  return ids.slice(0, 3).join(",");
}

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
      const code = safeMeridianErrorCode(error.code);
      return {
        error: {
          class: "MeridianError",
          category: error.source,
          ...(code !== undefined && { code }),
          retryable: error.retryable,
        },
      };
    }
  } catch {
    return { error: { class: "Error", category: "unexpected" } };
  }
  let nativeError = false;
  try {
    nativeError = error instanceof Error;
  } catch {
    return { error: { class: "Error", category: "unexpected" } };
  }
  if (nativeError) {
    const native = error as Error;
    const code = safeErrorScalar(ownDataValue(native, "code"));
    const rawStatus = ownDataValue(native, "status") ?? ownDataValue(native, "statusCode");
    const status =
      typeof rawStatus === "number" && Number.isFinite(rawStatus) ? rawStatus : undefined;
    const severity = ownDataValue(native, "severity");
    return {
      error: {
        class: safeErrorClass(native),
        category: severity === undefined ? "unexpected" : "database",
        ...(code !== undefined && { code }),
        ...(status !== undefined && { status }),
      },
    };
  }
  return { error: { class: typeof error, category: "unexpected" } };
}

const ERROR_MESSAGE_MAX = 200;

/**
 * A failure's message for diagnostics that must say what broke (the class and category
 * alone hid a lock re-entry for a release). Messages are server-authored, but one may
 * interpolate a writer's text, so quoted spans and secret-shaped tokens are dropped and
 * the rest is collapsed to one bounded line. Not a MeridianError's: those carry a code.
 */
export function errorMessageOf(error: unknown): { errorMessage: string } | undefined {
  try {
    if (!(error instanceof Error) || isMeridianError(error)) return undefined;
    const message = ownDataValue(error, "message");
    if (typeof message !== "string" || !message) return undefined;
    return {
      errorMessage: message
        .slice(0, ERROR_MESSAGE_MAX * 4)
        .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, "…")
        .replace(/\b(sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._~+/-]+=*)\b/g, "[redacted-secret]")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, ERROR_MESSAGE_MAX),
    };
  } catch {
    return undefined;
  }
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
