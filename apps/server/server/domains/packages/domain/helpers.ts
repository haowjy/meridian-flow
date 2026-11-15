/** Hashing and canonical-JSON helpers for package digests. */
import { createHash } from "node:crypto";

type JsonObject = Record<string, unknown>;

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * The id of one Agent as one reader version read one set of files: the same for every reader of
 * the same content, so the picker can name a revision before anything retains it.
 */
export function agentRevisionId(
  pkg: { coordinate: string; contentDigest: string },
  slug: string,
  grammarVersion: string,
): string {
  const hex = sha256(
    JSON.stringify(["agent-revision", pkg.coordinate, pkg.contentDigest, slug, grammarVersion]),
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
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
