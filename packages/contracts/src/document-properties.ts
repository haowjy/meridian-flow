/**
 * A document's imported frontmatter: stored verbatim beside its content (shared by
 * import and export), and read back as the DTO below. Properties are read-only in v1.
 */
import type { JsonValue } from "./threads/index.js";

/** Lossless stored document frontmatter (verbatim YAML) shared by import and export. */
export type StoredDocumentProperties = { format: "yaml"; text: string };

export function readStoredDocumentProperties(metadata: unknown): StoredDocumentProperties | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>).properties;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const properties = value as Record<string, unknown>;
  return Reflect.ownKeys(properties).length === 2 &&
    Object.hasOwn(properties, "format") &&
    Object.hasOwn(properties, "text") &&
    properties.format === "yaml" &&
    typeof properties.text === "string"
    ? (value as StoredDocumentProperties)
    : null;
}

/**
 * What the properties endpoint returns: the stored YAML parsed server-side, in
 * source order. Each entry's `source` is the text the writer wrote for a list
 * or map value, so nested values are shown as written rather than re-printed.
 * When the YAML cannot be read, `entries` and `aliases` are empty and the writer
 * is shown `text` as written. When it was too large to parse, `truncated` is
 * set and `text` is only its first part.
 */
export type DocumentProperties = {
  entries: Array<{ key: string; value: JsonValue; source: string | null }>;
  aliases: string[];
  unreadable: boolean;
  truncated: boolean;
  text: string;
};

/** The catalog carries only whether a document has properties worth fetching. */
export function hasDisplayableProperties(metadata: unknown): boolean {
  const stored = readStoredDocumentProperties(metadata);
  return stored !== null && stored.text.trim() !== "";
}
