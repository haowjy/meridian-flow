/**
 * Safe-event helpers: event id stamping plus conservative payload sanitization
 * used by every EventSink adapter before diagnostics leave process memory.
 * This is the boundary between ordinary searchable logs and protected replay
 * artifacts that may contain raw prompts, tool args, model text, or secrets.
 */
import type { EventRecord } from "./ports/event-sink.js";

const SENSITIVE_KEY_PATTERN =
  /(authorization|cookie|password|secret|token|api[_-]?key|prompt|messages|systemmessages|content|arguments|input|output|raw|stack)/i;
const SECRET_TEXT_PATTERN = /\b(sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._~+/-]+=*)\b/g;
const MAX_STRING_LENGTH = 1_000;
const MAX_ARRAY_ITEMS = 20;

function redactString(value: string): string {
  const withoutSecrets = value.replace(SECRET_TEXT_PATTERN, "[redacted-secret]");
  if (withoutSecrets.length <= MAX_STRING_LENGTH) return withoutSecrets;
  return `${withoutSecrets.slice(0, MAX_STRING_LENGTH)}…[truncated:${withoutSecrets.length}]`;
}

function sanitizeValue(key: string, value: unknown, depth: number): unknown {
  if (SENSITIVE_KEY_PATTERN.test(key)) return "[redacted]";
  if (value == null) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (depth > 5) return "[redacted-depth]";
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeValue("item", item, depth + 1));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [
        childKey,
        sanitizeValue(childKey, childValue, depth + 1),
      ]),
    );
  }
  return String(value);
}

export function sanitizeEventRecord(event: EventRecord): EventRecord {
  return {
    ...event,
    eventId: event.eventId ?? crypto.randomUUID(),
    sensitivity: event.sensitivity ?? "safe",
    payload: sanitizeValue("payload", event.payload, 0) as Record<string, unknown>,
  };
}

export function safeSnippet(value: string, maxLength = 160): string {
  const redacted = redactString(value);
  return redacted.length <= maxLength ? redacted : `${redacted.slice(0, maxLength)}…`;
}
