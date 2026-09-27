/** Extract the small, top-level argument subset needed for live tool labels. */
import type { JsonValue } from "@meridian/contracts/threads";

const ACTIVITY_FIELDS: Record<string, readonly string[]> = {
  write: ["command", "path", "uri"],
  edit: ["path", "uri"],
  read: ["path", "uri"],
  search: ["query", "pattern"],
  spawn: ["agent"],
};

type PartialToolActivityInput = Record<string, JsonValue>;

function skipWhitespace(input: string, index: number): number {
  while (/\s/.test(input[index] ?? "")) index++;
  return index;
}

function readString(input: string, start: number): { value: string; end: number } | null {
  if (input[start] !== '"') return null;
  for (let index = start + 1; index < input.length; index++) {
    if (input[index] === "\\") {
      index++;
      if (index >= input.length) return null;
      continue;
    }
    if (input[index] === '"') {
      try {
        return { value: JSON.parse(input.slice(start, index + 1)) as string, end: index + 1 };
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Skip one complete JSON value without descending into its object members. */
function skipValue(input: string, start: number): number | null {
  const first = input[start];
  if (first === '"') return readString(input, start)?.end ?? null;

  if (first === "{" || first === "[") {
    const expectedClosers = [first === "{" ? "}" : "]"];
    for (let index = start + 1; index < input.length; index++) {
      const character = input[index];
      if (character === '"') {
        const string = readString(input, index);
        if (!string) return null;
        index = string.end - 1;
      } else if (character === "{" || character === "[") {
        expectedClosers.push(character === "{" ? "}" : "]");
      } else if (character === "}" || character === "]") {
        if (expectedClosers.pop() !== character) return null;
        if (expectedClosers.length === 0) return index + 1;
      }
    }
    return null;
  }

  let index = start;
  while (index < input.length && !/[\s,}\]]/.test(input[index] ?? "")) index++;
  return index > start ? index : null;
}

/**
 * Read only string fields used by live activity labels. Complete top-level
 * strings survive an unfinished object or later truncated value; nested keys,
 * non-string values, and an unfinished string are ignored.
 */
export function parsePartialToolActivityInput(
  toolName: string,
  rawArguments: string,
): PartialToolActivityInput | null {
  const fields = ACTIVITY_FIELDS[toolName];
  if (!fields || !rawArguments) return null;

  let index = skipWhitespace(rawArguments, 0);
  if (rawArguments[index] !== "{") return null;
  index++;

  const selected = new Set(fields);
  const result: PartialToolActivityInput = {};
  while (index < rawArguments.length) {
    index = skipWhitespace(rawArguments, index);
    if (rawArguments[index] === "}" || index >= rawArguments.length) break;

    const key = readString(rawArguments, index);
    if (!key) break;
    index = skipWhitespace(rawArguments, key.end);
    if (rawArguments[index] !== ":") break;
    index = skipWhitespace(rawArguments, index + 1);
    if (index >= rawArguments.length) break;

    if (rawArguments[index] === '"') {
      const value = readString(rawArguments, index);
      if (!value) break;
      if (selected.has(key.value)) result[key.value] = value.value;
      index = value.end;
    } else {
      const end = skipValue(rawArguments, index);
      if (end === null) break;
      index = end;
    }

    index = skipWhitespace(rawArguments, index);
    if (rawArguments[index] === ",") index++;
    else if (rawArguments[index] !== "}" && index < rawArguments.length) break;
  }

  return Object.keys(result).length > 0 ? result : null;
}

/** Whether parsed input has the field that makes a live label name its target. */
export function hasPartialToolActivityTarget(
  toolName: string,
  input: PartialToolActivityInput | null,
): boolean {
  if (!input) return false;
  const hasText = (...keys: string[]) =>
    keys.some((key) => typeof input[key] === "string" && input[key].trim().length > 0);

  switch (toolName) {
    case "write":
      // `write` also reads and diffs; its verb comes from the command.
      return hasText("command") && hasText("path", "uri");
    case "edit":
    case "read":
      return hasText("path", "uri");
    case "search":
      return hasText("query", "pattern");
    case "spawn":
      return hasText("agent");
    default:
      return false;
  }
}

/**
 * Whether a call's first streamed chunk may show before its target. A `write`
 * waits for its command instead: labeled early, every read would flash as a
 * write. Its command and path arrive in the first few dozen characters.
 */
export function showsPartialToolActivityBeforeTarget(toolName: string): boolean {
  return toolName !== "write";
}
