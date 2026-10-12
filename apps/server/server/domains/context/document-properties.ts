/**
 * Reads a document's stored frontmatter into the properties DTO. The text stays
 * the authority: this only parses it for display, in source key order, and
 * reports YAML it cannot read rather than guessing at it.
 */
import type { DocumentProperties, StoredDocumentProperties } from "@meridian/contracts";
import type { JsonValue } from "@meridian/contracts/threads";
import YAML from "yaml";

export function parseDocumentProperties(stored: StoredDocumentProperties): DocumentProperties {
  const unreadable: DocumentProperties = {
    entries: [],
    aliases: [],
    unreadable: true,
    text: stored.text,
  };
  const document = YAML.parseDocument(stored.text);
  // Duplicate keys are an error here, so they show as written instead of one silently winning.
  if (document.errors.length > 0) return unreadable;
  // Frontmatter that is only comments has no keys, which is readable and shows nothing.
  if (document.contents === null) return { ...unreadable, unreadable: false };
  if (!YAML.isMap(document.contents)) return unreadable;

  const entries: DocumentProperties["entries"] = [];
  for (const pair of document.contents.items) {
    const key = YAML.isScalar(pair.key) ? pair.key.value : pair.key?.toJSON();
    if (key === null || key === undefined) return unreadable;
    entries.push({
      key: String(key),
      value: toJsonValue(
        YAML.isNode(pair.value) ? pair.value.toJS(document) : (pair.value as unknown),
      ),
    });
  }
  return { entries, aliases: aliasesOf(entries), unreadable: false, text: stored.text };
}

/** `aliases` as a name or a list of names; anything else in that key is not an alias. */
function aliasesOf(entries: DocumentProperties["entries"]): string[] {
  const value = entries.find((entry) => entry.key === "aliases")?.value;
  if (typeof value === "string") return [value];
  return Array.isArray(value)
    ? value.filter((alias): alias is string => typeof alias === "string")
    : [];
}

/** YAML can hold what JSON cannot (`.inf`, dates, bigints); those travel as their text. */
function toJsonValue(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, toJsonValue(inner)]),
    );
  }
  return String(value);
}
