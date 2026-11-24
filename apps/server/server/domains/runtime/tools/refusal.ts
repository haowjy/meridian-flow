import type { JsonObject, JsonValue } from "@meridian/contracts/threads";

const UNINFORMATIVE_CODES = new Set([
  "tool_error",
  "tool_exception",
  "tool_timeout",
  "tool_arguments_parse",
]);

export function isMeridianErrorValue(value: JsonValue): value is JsonObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof value.code === "string" &&
    typeof value.message === "string" &&
    typeof value.source === "string"
  );
}

export function renderRefusal(value: JsonValue): string {
  const error =
    typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
  if (typeof error?.message !== "string") return JSON.stringify(value);
  const code = typeof error.code === "string" ? error.code : undefined;
  return code && !UNINFORMATIVE_CODES.has(code) && !error.message.includes(code)
    ? `${error.message} (${code})`
    : error.message;
}
