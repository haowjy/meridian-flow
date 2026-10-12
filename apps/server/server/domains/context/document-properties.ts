/**
 * Reads a document's stored frontmatter into the properties DTO. The text stays
 * the authority: this only parses it for display, in source key order, and
 * reports YAML it cannot read rather than guessing at it.
 *
 * The text is untrusted (it arrives from imports), so parsing is bounded: a
 * size cap before the parser runs, the core schema only (a tag it does not
 * know makes the properties unreadable), and a document-wide budget on the
 * nodes and depth the converter will visit. Aliases are resolved by that
 * converter rather than by the library, so a cycle or an expanding alias stops
 * at the budget. Every failure becomes `unreadable` with the text, never an error.
 */
import type { DocumentProperties, StoredDocumentProperties } from "@meridian/contracts";
import type { JsonValue } from "@meridian/contracts/threads";
import YAML from "yaml";

/** Frontmatter beyond this is shown as written without being parsed. */
export const MAX_PROPERTIES_TEXT_LENGTH = 32_768;
const MAX_NODES = 10_000;
const MAX_DEPTH = 32;

/** Thrown inside the converter for YAML that is valid but beyond what we show. */
class NotShowable extends Error {}

type Entries = DocumentProperties["entries"];

export function parseDocumentProperties(stored: StoredDocumentProperties): DocumentProperties {
  if (stored.text.length > MAX_PROPERTIES_TEXT_LENGTH) return tooLarge(stored.text);
  try {
    return parseBounded(stored.text) ?? unreadable(stored.text);
  } catch {
    // The parser or converter gave up (deep nesting, a cycle, the budget): show the text.
    return unreadable(stored.text);
  }
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

function parseBounded(text: string): DocumentProperties | null {
  const document = YAML.parseDocument(text, { version: "1.2", schema: "core" });
  // Errors include duplicate keys, which show as written instead of one silently winning.
  // Warnings include a tag the core schema does not know, whose meaning we would lose.
  if (document.errors.length > 0 || document.warnings.length > 0) return null;
  // Frontmatter that is only comments has no keys, which is readable and shows nothing.
  if (document.contents === null) {
    return { entries: [], aliases: [], unreadable: false, truncated: false, text };
  }
  if (!YAML.isMap(document.contents)) return null;

  const budget = { nodes: 0 };
  const entries: Entries = [];
  for (const pair of document.contents.items) {
    const key = keyText(pair.key);
    const node = pair.value;
    const value = convert(node, document, [], budget);
    entries.push({
      key,
      value,
      source: isShownAsSource(value) ? sourceOf(text, node, document) : null,
    });
  }
  return { entries, aliases: aliasesOf(entries), unreadable: false, truncated: false, text };
}

function keyText(key: unknown): string {
  if (!YAML.isScalar(key) || key.value === null || key.value === undefined) {
    throw new NotShowable("key");
  }
  return String(key.value);
}

/** A node as JSON, expanding aliases within the document-wide budget. */
function convert(
  node: unknown,
  document: YAML.Document,
  path: readonly object[],
  budget: { nodes: number },
): JsonValue {
  if (node === null || node === undefined) return null;
  if (++budget.nodes > MAX_NODES || path.length > MAX_DEPTH) throw new NotShowable("budget");
  if (YAML.isAlias(node)) {
    const target = node.resolve(document);
    if (!target || path.includes(target)) throw new NotShowable("alias");
    return convert(target, document, path, budget);
  }
  if (YAML.isScalar(node)) return scalarJson(node.value);
  const inner = [...path, node as object];
  if (YAML.isSeq(node)) return node.items.map((item) => convert(item, document, inner, budget));
  if (YAML.isMap(node)) {
    const map: { [key: string]: JsonValue } = {};
    for (const pair of node.items)
      map[keyText(pair.key)] = convert(pair.value, document, inner, budget);
    return map;
  }
  throw new NotShowable("node");
}

/** YAML can hold what JSON cannot (`.inf`, bigints); those travel as their text. */
function scalarJson(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  return String(value);
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

/** `aliases` as a name or a list of names; anything else in that key is not an alias. */
function aliasesOf(entries: Entries): string[] {
  const value = entries.find((entry) => entry.key === "aliases")?.value;
  if (typeof value === "string") return [value];
  return Array.isArray(value)
    ? value.filter((alias): alias is string => typeof alias === "string")
    : [];
}
