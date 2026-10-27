/**
 * The one frontmatter policy: which stored YAML Meridian reads and which aliases
 * it names. Import (link aliases, the unreadable finding) and the properties
 * display both read through here, so they never disagree about either.
 *
 * The text is untrusted (it arrives from imports), so parsing is bounded: a
 * size cap before the parser runs, the core schema only (a tag it does not
 * know makes the text unreadable), and a document-wide budget on the nodes and
 * depth the converter will visit. Aliases are resolved by that converter
 * rather than by the library, so a cycle or an expanding alias stops at the
 * budget. Every failure is `unreadable`, never an error.
 */
import type { JsonValue } from "@meridian/contracts/threads";
import YAML from "yaml";

/** Frontmatter beyond this is kept as written without being parsed. */
export const MAX_PROPERTIES_TEXT_LENGTH = 32_768;
const MAX_NODES = 10_000;
const MAX_DEPTH = 32;

/** Thrown inside the converter for YAML that is valid but beyond what we read. */
class NotReadable extends Error {}

export interface FrontmatterEntry {
  key: string;
  value: JsonValue;
  /** The value's node, for projections that show it as written. */
  node: unknown;
}

export type ReadFrontmatter =
  | {
      readable: true;
      entries: FrontmatterEntry[];
      aliases: string[];
      document: YAML.Document;
    }
  | { readable: false; tooLarge: boolean };

export function readFrontmatter(text: string): ReadFrontmatter {
  if (text.length > MAX_PROPERTIES_TEXT_LENGTH) return { readable: false, tooLarge: true };
  try {
    return parseBounded(text) ?? { readable: false, tooLarge: false };
  } catch {
    // The parser or converter gave up (deep nesting, a cycle, the budget).
    return { readable: false, tooLarge: false };
  }
}

/** The aliases a document's frontmatter names; none when it is unreadable. */
export function frontmatterAliases(text: string): string[] {
  const read = readFrontmatter(text);
  return read.readable ? read.aliases : [];
}

function parseBounded(text: string): ReadFrontmatter | null {
  const document = YAML.parseDocument(text, { version: "1.2", schema: "core" });
  // Errors include duplicate keys, which stay as written instead of one silently winning.
  // Warnings include a tag the core schema does not know, whose meaning we would lose.
  if (document.errors.length > 0 || document.warnings.length > 0) return null;
  // Frontmatter that is only comments has no keys, which is readable and names nothing.
  if (document.contents === null) return { readable: true, entries: [], aliases: [], document };
  if (!YAML.isMap(document.contents)) return null;

  const budget = { nodes: 0 };
  const entries: FrontmatterEntry[] = document.contents.items.map((pair) => ({
    key: keyText(pair.key),
    value: convert(pair.value, document, [], budget),
    node: pair.value,
  }));
  return { readable: true, entries, aliases: aliasesOf(entries), document };
}

function keyText(key: unknown): string {
  if (!YAML.isScalar(key) || key.value === null || key.value === undefined) {
    throw new NotReadable("key");
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
  if (++budget.nodes > MAX_NODES || path.length > MAX_DEPTH) throw new NotReadable("budget");
  if (YAML.isAlias(node)) {
    const target = node.resolve(document);
    if (!target || path.includes(target)) throw new NotReadable("alias");
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
  throw new NotReadable("node");
}

/** YAML can hold what JSON cannot (`.inf`, bigints); those travel as their text. */
function scalarJson(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  return String(value);
}

/** `aliases` as a name or a list of names; anything else in that key is not an alias. */
function aliasesOf(entries: readonly FrontmatterEntry[]): string[] {
  const value = entries.find((entry) => entry.key === "aliases")?.value;
  if (typeof value === "string") return [value];
  return Array.isArray(value)
    ? value.filter((alias): alias is string => typeof alias === "string")
    : [];
}
