/** Hashing and canonical-JSON helpers for package digests. */
import { createHash } from "node:crypto";

type JsonObject = Record<string, unknown>;

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Canonical JSON object for checksum stability — keys sorted recursively. */
export function canonicalizeJsonObject(value: JsonObject): JsonObject {
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalizeJsonValue(value[key])]),
  );
}

/**
 * Arrays are descended into because Postgres jsonb scrambles the key order of objects nested
 * inside them just like top-level objects.
 */
function canonicalizeJsonValue(entry: unknown): unknown {
  if (Array.isArray(entry)) return entry.map(canonicalizeJsonValue);
  if (entry && typeof entry === "object") return canonicalizeJsonObject(entry as JsonObject);
  return entry;
}
