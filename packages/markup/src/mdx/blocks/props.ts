import { isJsonValue, type JsonValue } from "../../helpers.js";

export function propsRecord(value: unknown): Record<string, JsonValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const entries: Record<string, JsonValue> = {};
  for (const [key, prop] of Object.entries(value)) {
    if (!isJsonValue(prop)) throw new Error(`JSX prop "${key}" is not JSON-serializable`);
    entries[key] = prop;
  }
  return entries;
}
