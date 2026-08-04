/**
 * Safe-event helpers: event id stamping plus conservative envelope sanitization
 * used at an EventSink boundary before diagnostics leave process memory.
 * This is the boundary between ordinary searchable logs and protected replay
 * artifacts that may contain raw prompts, tool args, model text, or secrets.
 */
import type { EventRecord } from "./ports/event-sink.js";

const SENSITIVE_KEY_PATTERN =
  /(authorization|cookie|password|secret|token|api[_-]?key|prompt|messages|systemmessages|content|arguments|input|output|raw|stack)/i;
const SECRET_TEXT_PATTERN = /\b(sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._~+/-]+=*)\b/g;
const MAX_STRING_LENGTH = 1_000;
const MAX_IDENTIFIER_LENGTH = 128;
const MAX_ARRAY_ITEMS = 20;
const MAX_OBJECT_KEYS = 50;
export const MAX_EVENT_RECORD_BYTES = 8 * 1_024;
/** Metric keys whose names collide with the sensitive pattern may carry only finite numbers. */
const SAFE_METRIC_KEYS = new Set(["firstOutputMs", "inputTokens", "outputTokens"]);

function redactString(value: string): string {
  const withoutSecrets = value.replace(SECRET_TEXT_PATTERN, "[redacted-secret]");
  if (withoutSecrets.length <= MAX_STRING_LENGTH) return withoutSecrets;
  return `${withoutSecrets.slice(0, MAX_STRING_LENGTH)}…[truncated:${withoutSecrets.length}]`;
}

function boundedIdentifier(value: string): string {
  return redactString(value).slice(0, MAX_IDENTIFIER_LENGTH);
}

function sanitizeIdentifierRecord<T extends object>(value: T): T {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(value)
        .slice(0, MAX_OBJECT_KEYS)
        .map(([key, item]) => [
          key,
          typeof item === "string"
            ? boundedIdentifier(item)
            : typeof item === "number" && Number.isFinite(item)
              ? item
              : typeof item === "boolean"
                ? item
                : "[redacted]",
        ]),
    ),
  ) as unknown as T;
}

function sanitizeValue(key: string, value: unknown, depth: number): unknown {
  const isSafeMetric =
    SAFE_METRIC_KEYS.has(key) && typeof value === "number" && Number.isFinite(value);
  if (!isSafeMetric && SENSITIVE_KEY_PATTERN.test(key)) return "[redacted]";
  if (value == null) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (depth > 5) return "[redacted-depth]";
  if (Array.isArray(value)) {
    return Object.freeze(
      value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeValue("item", item, depth + 1)),
    );
  }
  if (typeof value === "object") {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .slice(0, MAX_OBJECT_KEYS)
          .map(([childKey, childValue]) => [
            childKey,
            sanitizeValue(childKey, childValue, depth + 1),
          ]),
      ),
    );
  }
  return String(value);
}

export function sanitizeEventRecord(event: EventRecord): EventRecord {
  const sanitized = {
    eventId: boundedIdentifier(event.eventId ?? crypto.randomUUID()),
    timestamp: boundedIdentifier(event.timestamp),
    level: event.level,
    source: boundedIdentifier(event.source),
    name: boundedIdentifier(event.name),
    sensitivity: event.sensitivity ?? "safe",
    payload: sanitizeValue("payload", event.payload, 0) as Record<string, unknown>,
    ...(event.correlation !== undefined && {
      correlation: sanitizeIdentifierRecord(event.correlation),
    }),
    ...(event.stream !== undefined && {
      stream: sanitizeIdentifierRecord(event.stream),
    }),
  } satisfies EventRecord;
  const originalBytes = serializedEventBytes(sanitized);
  if (originalBytes <= MAX_EVENT_RECORD_BYTES) return Object.freeze(sanitized);

  const truncated = Object.freeze({
    ...sanitized,
    payload: Object.freeze({
      truncated: true,
      originalBytes,
      reason: "record_byte_limit",
    }),
  });
  if (serializedEventBytes(truncated) <= MAX_EVENT_RECORD_BYTES) return truncated;

  // Correlation and stream are structurally bounded, but retain a minimal
  // envelope if an untyped caller supplies enough extra keys to exceed the
  // byte ceiling. A hard storage bound is more important than hostile context.
  return Object.freeze({
    eventId: truncated.eventId,
    timestamp: truncated.timestamp,
    level: truncated.level,
    source: truncated.source,
    name: truncated.name,
    sensitivity: truncated.sensitivity,
    payload: truncated.payload,
  });
}

export function serializedEventBytes(event: EventRecord): number {
  return Buffer.byteLength(JSON.stringify(event), "utf8");
}

export function safeSnippet(value: string, maxLength = 160): string {
  const redacted = redactString(value);
  return redacted.length <= maxLength ? redacted : `${redacted.slice(0, maxLength)}…`;
}
