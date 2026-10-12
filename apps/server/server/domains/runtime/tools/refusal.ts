/**
 * A tool refusal as the model reads it (D65): the `MeridianError`'s message,
 * then its code when the message doesn't already carry it. `details` stays on
 * the typed result for the app; every message names what the model needs.
 */
import type { JsonObject, JsonValue } from "@meridian/contracts/threads";

/** The executor's generic code says nothing the message doesn't. */
const UNINFORMATIVE_CODES = new Set(["tool_error"]);

/** A `MeridianError` as JSON: what `toolError` and the executor's own failures return. */
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
