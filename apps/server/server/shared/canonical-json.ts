type JsonObject = Record<string, unknown>;

export function canonicalizeJsonObject(value: JsonObject): JsonObject {
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalizeJsonValue(value[key])]),
  );
}

// Canonicalize object keys inside arrays too; Postgres jsonb scrambles nested key order
function canonicalizeJsonValue(entry: unknown): unknown {
  if (Array.isArray(entry)) return entry.map(canonicalizeJsonValue);
  if (entry && typeof entry === "object") return canonicalizeJsonObject(entry as JsonObject);
  return entry;
}
