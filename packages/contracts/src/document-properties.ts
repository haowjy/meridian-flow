/**
 * A document's imported frontmatter: stored verbatim beside its content, and read
 * back as the DTO below. Properties are read-only in v1.
 */
import type { JsonValue } from "./threads/index.js";

/** Verbatim YAML properties stored beside document content. */
export type StoredDocumentProperties = { format: "yaml"; text: string };
export function readStoredDocumentProperties(metadata: unknown): StoredDocumentProperties | null {
  if (!metadata || typeof metadata !== "object" || !("properties" in metadata)) return null;
  const value = metadata.properties;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Reflect.ownKeys(value);
  return keys.length === 2 &&
    keys.includes("format") &&
    keys.includes("text") &&
    "format" in value &&
    value.format === "yaml" &&
    "text" in value &&
    typeof value.text === "string"
    ? (value as StoredDocumentProperties)
    : null;
}

/**
 * What the properties endpoint returns: the stored YAML parsed server-side, in
 * source order. When the YAML cannot be read, `entries` and `aliases` are empty
 * and the writer is shown `text` as written.
 */
export type DocumentProperties = {
  entries: Array<{ key: string; value: JsonValue }>;
  aliases: string[];
  unreadable: boolean;
  text: string;
};

/** The catalog carries only whether a document has properties worth fetching. */
export function hasDisplayableProperties(metadata: unknown): boolean {
  const stored = readStoredDocumentProperties(metadata);
  return stored !== null && stored.text.trim() !== "";
}
