/**
 * Projects a document's stored frontmatter into the properties DTO for display:
 * entries in source key order, list and map values with their own source text,
 * and the head of over-long text. The text stays the authority; what is readable
 * and which aliases it names belong to the shared frontmatter policy.
 */
import type { DocumentProperties, StoredDocumentProperties } from "@meridian/contracts";
import type { JsonValue } from "@meridian/contracts/threads";
import YAML from "yaml";
import { MAX_PROPERTIES_TEXT_LENGTH, readFrontmatter } from "./frontmatter.js";

export function parseDocumentProperties(stored: StoredDocumentProperties): DocumentProperties {
  const read = readFrontmatter(stored.text);
  if (!read.readable) return read.tooLarge ? tooLarge(stored.text) : unreadable(stored.text);
  return {
    entries: read.entries.map(({ key, value, node }) => ({
      key,
      value,
      source: isShownAsSource(value) ? sourceOf(stored.text, node, read.document) : null,
    })),
    aliases: read.aliases,
    unreadable: false,
    truncated: false,
    text: stored.text,
  };
}

function unreadable(text: string): DocumentProperties {
  return { entries: [], aliases: [], unreadable: true, truncated: false, text };
}

/** Only the first part of the text is sent; the note says so. */
function tooLarge(text: string): DocumentProperties {
  const head = text.slice(0, MAX_PROPERTIES_TEXT_LENGTH);
  const lineEnd = head.lastIndexOf("\n");
  return { ...unreadable(lineEnd > 0 ? head.slice(0, lineEnd) : head), truncated: true };
}

/** Lists and maps are the values a chip or a word can't show; they carry their source. */
function isShownAsSource(value: JsonValue): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return typeof value === "object" && value !== null && Object.keys(value).length > 0;
}

/**
 * A value's own text from the document, as written: comments and spacing kept,
 * with the indent of its block removed so it reads from the left edge. An alias
 * shows the node it names, which is where the writer wrote the content.
 */
function sourceOf(text: string, node: unknown, document: YAML.Document): string | null {
  const target = YAML.isAlias(node) ? node.resolve(document) : node;
  if (!YAML.isNode(target) || !target.range) return null;
  const [start, end] = target.range;
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  // A block value starts its own line; a flow value follows its key on the same line.
  const startsLine = text.slice(lineStart, start).trim() === "";
  const lines = text
    .slice(startsLine ? lineStart : start, end)
    .trimEnd()
    .split("\n");
  if (!startsLine) return lines.join("\n");
  const indent = Math.min(
    ...lines
      .filter((line) => line.trim() !== "")
      .map((line) => line.length - line.trimStart().length),
  );
  return lines.map((line) => line.slice(indent)).join("\n");
}
