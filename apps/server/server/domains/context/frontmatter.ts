import type { JsonValue } from "@meridian/contracts/threads";
import YAML from "yaml";

export const MAX_PROPERTIES_TEXT_LENGTH = 32_768;
const MAX_NODES = 10_000;
const MAX_DEPTH = 32;

class NotReadable extends Error {}

export interface FrontmatterEntry {
  key: string;
  value: JsonValue;
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
    return { readable: false, tooLarge: false };
  }
}

export function frontmatterAliases(text: string): string[] {
  const read = readFrontmatter(text);
  return read.readable ? read.aliases : [];
}

function parseBounded(text: string): ReadFrontmatter | null {
  const document = YAML.parseDocument(text, { version: "1.2", schema: "core" });
  if (document.errors.length > 0 || document.warnings.length > 0) return null;
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

function scalarJson(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  return String(value);
}

function aliasesOf(entries: readonly FrontmatterEntry[]): string[] {
  const value = entries.find((entry) => entry.key === "aliases")?.value;
  if (typeof value === "string") return [value];
  return Array.isArray(value)
    ? value.filter((alias): alias is string => typeof alias === "string")
    : [];
}
