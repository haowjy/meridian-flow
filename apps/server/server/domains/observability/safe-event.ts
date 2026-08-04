/**
 * Safe-event helpers: event id stamping plus conservative envelope sanitization
 * used at an EventSink boundary before diagnostics leave process memory.
 * This is the boundary between ordinary searchable logs and protected replay
 * artifacts that may contain raw prompts, tool args, model text, or secrets.
 */
import type { EventRecord } from "./ports/event-sink.js";

const SENSITIVE_KEY_PATTERN =
  /(authorization|cookie|password|secret|token|api[_-]?key|prompt|systemmessages|content|arguments|input|output|raw|stack|cause|query|sql)/i;
const SENSITIVE_EXACT_KEYS = new Set(["body", "message", "messages", "response"]);
const SECRET_TEXT_PATTERN = /\b(sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._~+/-]+=*)\b/g;
const MAX_STRING_LENGTH = 1_000;
const MAX_IDENTIFIER_LENGTH = 128;
const MAX_ARRAY_ITEMS = 20;
const MAX_OBJECT_KEYS = 50;
export const MAX_EVENT_RECORD_BYTES = 8 * 1_024;
/** Metric keys whose names collide with the sensitive pattern may carry only finite numbers. */
const SAFE_METRIC_KEYS = new Set(["firstOutputMs", "inputTokens", "outputTokens"]);
const SAFE_PAYLOAD_STRING_KEYS = new Set([
  "action",
  "command",
  "direction",
  "deletedNodeTypes",
  "documentId",
  "documentIds",
  "errorCode",
  "field",
  "fields",
  "gatewayCallId",
  "kind",
  "level",
  "logPrefix",
  "method",
  "model",
  "name",
  "originType",
  "outcome",
  "phase",
  "projectId",
  "provider",
  "reason",
  "requestId",
  "responseId",
  "responseTransactionId",
  "roomKey",
  "runId",
  "route",
  "schemaVersion",
  "sessionId",
  "source",
  "status",
  "threadId",
  "toolCallId",
  "toolName",
  "toolUseId",
  "transport",
  "turnId",
  "workId",
  "yjsSpans",
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

function payloadStringIsApproved(key: string, value: string): boolean {
  return SAFE_PAYLOAD_STRING_KEYS.has(key) && /^[A-Za-z0-9_./:-]+$/.test(value);
}

function redactString(value: string): string {
  const candidate = value.slice(0, MAX_STRING_LENGTH + 256);
  const withoutSecrets = candidate.replace(SECRET_TEXT_PATTERN, "[redacted-secret]");
  if (value.length <= MAX_STRING_LENGTH && withoutSecrets.length <= MAX_STRING_LENGTH) {
    return withoutSecrets;
  }
  return `${withoutSecrets.slice(0, MAX_STRING_LENGTH)}…[truncated:${value.length}]`;
}

function boundedIdentifier(value: unknown): string {
  return typeof value === "string"
    ? redactString(value).slice(0, MAX_IDENTIFIER_LENGTH)
    : "[invalid]";
}

function sanitizeIdentifierRecord<T extends object>(value: T): T {
  if (!isPlainRecord(value)) return Object.freeze({}) as T;
  const entries: Array<[string, unknown]> = [];
  try {
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      entries.push([
        boundedIdentifier(key),
        descriptor && "value" in descriptor ? descriptor.value : "[redacted]",
      ]);
      if (entries.length === MAX_OBJECT_KEYS) break;
    }
  } catch {
    return Object.freeze({}) as T;
  }
  return Object.freeze(
    Object.fromEntries(
      entries.map(([key, item]) => [
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

function isPlainRecord(value: object): boolean {
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function ownDataValue(value: Record<string, unknown>, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function safeErrorEnvelope(value: unknown): Record<string, unknown> | "[redacted]" {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "[redacted]";
  if (!isPlainRecord(value)) return "[redacted]";
  const candidate = value as Record<string, unknown>;
  const candidateCode = ownDataValue(candidate, "code");
  const candidateSource = ownDataValue(candidate, "source");
  const candidateRetryable = ownDataValue(candidate, "retryable");
  if (
    typeof candidateCode === "string" &&
    /^[a-z][a-z0-9_]{0,63}$/.test(candidateCode) &&
    (candidateSource === "gateway" ||
      candidateSource === "tool" ||
      candidateSource === "child-agent" ||
      candidateSource === "system") &&
    typeof candidateRetryable === "boolean"
  ) {
    return Object.freeze({
      class: "MeridianError",
      category: candidateSource,
      code: candidateCode,
      retryable: candidateRetryable,
    });
  }
  const candidateClass = ownDataValue(candidate, "class");
  const candidateCategory = ownDataValue(candidate, "category");
  const candidateStatus = ownDataValue(candidate, "status");
  const errorClass =
    typeof candidateClass === "string" &&
    /^(?:Error|TypeError|RangeError|ReferenceError|SyntaxError|URIError|EvalError|AggregateError|MeridianError)$/.test(
      candidateClass,
    )
      ? candidateClass
      : "Error";
  const category =
    candidateCategory === "database" ||
    candidateCategory === "unexpected" ||
    candidateCategory === "gateway" ||
    candidateCategory === "tool" ||
    candidateCategory === "child-agent" ||
    candidateCategory === "system"
      ? candidateCategory
      : "unexpected";
  const code =
    (typeof candidateCode === "string" &&
      (/^[A-Z0-9]{5}$/.test(candidateCode) || SAFE_ERROR_CODES.has(candidateCode))) ||
    (typeof candidateCode === "number" && Number.isFinite(candidateCode))
      ? candidateCode
      : undefined;
  const status =
    typeof candidateStatus === "number" && Number.isFinite(candidateStatus)
      ? candidateStatus
      : undefined;
  return Object.freeze({
    class: errorClass,
    category,
    ...(code !== undefined && { code }),
    ...(status !== undefined && { status }),
    ...(typeof candidateRetryable === "boolean" && { retryable: candidateRetryable }),
  });
}

function boundedOwnEntries(value: Record<string, unknown>): Array<[string, unknown]> {
  if (!isPlainRecord(value)) return [];
  const entries: Array<[string, unknown]> = [];
  try {
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      entries.push([
        boundedIdentifier(key),
        descriptor && "value" in descriptor ? descriptor.value : "[redacted]",
      ]);
      if (entries.length === MAX_OBJECT_KEYS) break;
    }
  } catch {
    return [];
  }
  return entries;
}

function sanitizeValue(key: string, value: unknown, depth: number): unknown {
  if (key === "error") return safeErrorEnvelope(value);
  const isSafeMetric =
    SAFE_METRIC_KEYS.has(key) && typeof value === "number" && Number.isFinite(value);
  if (
    !isSafeMetric &&
    (SENSITIVE_EXACT_KEYS.has(key.toLowerCase()) || SENSITIVE_KEY_PATTERN.test(key))
  )
    return "[redacted]";
  if (value == null) return value;
  if (typeof value === "string") {
    return payloadStringIsApproved(key, value) ? redactString(value) : "[redacted]";
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (depth > 5) return "[redacted-depth]";
  if (Array.isArray(value)) {
    return Object.freeze(
      value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeValue(key, item, depth + 1)),
    );
  }
  if (typeof value === "object") {
    if (!isPlainRecord(value)) return "[redacted-object]";
    return Object.freeze(
      Object.fromEntries(
        boundedOwnEntries(value as Record<string, unknown>).map(([childKey, childValue]) => [
          childKey,
          sanitizeValue(childKey, childValue, depth + 1),
        ]),
      ),
    );
  }
  return "[redacted-type]";
}

function eventLevel(value: unknown): EventRecord["level"] {
  return value === "trace" ||
    value === "debug" ||
    value === "info" ||
    value === "warn" ||
    value === "error" ||
    value === "fatal"
    ? value
    : "error";
}

function eventSensitivity(value: unknown): EventRecord["sensitivity"] {
  return value === "protected_reference" ? value : "safe";
}

function sanitizePayload(value: unknown): Record<string, unknown> {
  const sanitized = sanitizeValue("payload", value, 0);
  return sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)
    ? (sanitized as Record<string, unknown>)
    : Object.freeze({ redacted: true });
}

export function sanitizeEventRecord(event: EventRecord): EventRecord {
  const sanitized = {
    eventId: boundedIdentifier(event.eventId ?? crypto.randomUUID()),
    timestamp: boundedIdentifier(event.timestamp),
    level: eventLevel(event.level),
    source: boundedIdentifier(event.source),
    name: boundedIdentifier(event.name),
    sensitivity: eventSensitivity(event.sensitivity),
    payload: sanitizePayload(event.payload),
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
  const minimal = Object.freeze({
    eventId: truncated.eventId,
    timestamp: truncated.timestamp,
    level: truncated.level,
    source: truncated.source,
    name: truncated.name,
    sensitivity: truncated.sensitivity,
    payload: truncated.payload,
  });
  if (serializedEventBytes(minimal) <= MAX_EVENT_RECORD_BYTES) return minimal;
  return Object.freeze({
    eventId: "record-truncated",
    timestamp: "1970-01-01T00:00:00.000Z",
    level: "error",
    source: "observability",
    name: "record.truncated",
    sensitivity: "safe",
    payload: Object.freeze({ truncated: true, reason: "record_byte_limit" }),
  });
}

export function serializedEventBytes(event: EventRecord): number {
  return Buffer.byteLength(JSON.stringify(event), "utf8");
}

export function safeSnippet(value: string, maxLength = 160): string {
  const redacted = redactString(value);
  return redacted.length <= maxLength ? redacted : `${redacted.slice(0, maxLength)}…`;
}
