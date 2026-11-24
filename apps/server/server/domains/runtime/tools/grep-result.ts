import { toHashline } from "@meridian/agent-edit";
import type { JsonObject, JsonValue } from "@meridian/contracts/threads";
import type { GrepPassage } from "../../context/index.js";

export interface GrepHit {
  uri: string;
  matches: GrepPassage[];
  matchCount?: number;
  readonly?: boolean;
}

export interface GrepToolResult {
  files: GrepHit[];
  totalFiles: number;
  exact: boolean;
  stopped?: true;
}

const WINDOW = 120;
const SLACK = 24;

const CLEARED_GREP_PASSAGES = "[Cleared at compaction: changed since this grep]";

export function isGrepResult(value: JsonValue | undefined): value is JsonObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof value.totalFiles === "number" &&
    Array.isArray(value.files) &&
    value.files.every(
      (hit) =>
        typeof hit === "object" &&
        hit !== null &&
        !Array.isArray(hit) &&
        typeof hit.uri === "string" &&
        Array.isArray(hit.matches),
    )
  );
}

export function renderGrepResult(value: JsonValue, input: JsonObject): string {
  if (!isGrepResult(value)) return JSON.stringify(value);
  return renderGrepFiles(value as unknown as GrepToolResult, input);
}

export function renderGrepFiles(
  { files, totalFiles, exact, stopped }: GrepToolResult,
  input: JsonObject,
  cleared: (hit: GrepHit) => boolean = () => false,
): string {
  if (files.length === 0)
    return exact ? "No matches." : "No matches found before the search stopped.";
  const verbose = input.verbose === true;
  const mode = input.output_mode;
  const lines = files.map((hit) => {
    const readonly = hit.readonly ? "read-only" : undefined;
    if (mode === "files_with_matches") return readonly ? `${hit.uri} (${readonly})` : hit.uri;
    if (mode === "count") {
      const notes = [matches(hit.matchCount ?? 0), readonly].filter((note) => note !== undefined);
      return `${hit.uri} (${notes.join(", ")})`;
    }
    const notes = [
      (hit.matchCount ?? 0) > hit.matches.length ? matches(hit.matchCount ?? 0) : undefined,
      readonly,
    ].filter((note) => note !== undefined);
    const head = notes.length > 0 ? `${hit.uri} (${notes.join(", ")})` : hit.uri;
    if (cleared(hit)) return `${head}\n${CLEARED_GREP_PASSAGES}`;
    const passages = hit.matches.map((passage) => {
      const { text } = grepPassage(passage, verbose);
      return passage.blockHash ? toHashline(passage.blockHash, text) : text;
    });
    return [head, ...passages].join("\n");
  });
  const body = lines.join(mode === "files_with_matches" || mode === "count" ? "\n" : "\n\n");
  if (stopped) return `${body}\n\nThe search stopped before it finished.`;
  return totalFiles > files.length || !exact
    ? `${body}\n\n${files.length} of ${exact ? "" : "at least "}${totalFiles} files.`
    : body;
}

export function renderGrepFileList({ files }: GrepToolResult): string {
  return [
    "[grep passages omitted]",
    ...files.map((hit) =>
      hit.matchCount === undefined ? hit.uri : `${hit.uri} (${matches(hit.matchCount)})`,
    ),
  ].join("\n");
}

function matches(count: number): string {
  return count === 1 ? "1 match" : `${count} matches`;
}

export function grepPassage(
  passage: GrepPassage,
  verbose: boolean,
): { text: string; whole: boolean } {
  return verbose ? { text: passage.excerpt, whole: true } : around(passage);
}

function around({ excerpt, anchor }: GrepPassage): { text: string; whole: boolean } {
  const flat = excerpt.replace(/\s+/gu, " ").trim();
  const flatOffset = (offset: number) =>
    excerpt.slice(0, offset).replace(/\s+/gu, " ").trimStart().length;
  const at = anchor ? Math.min(flatOffset(anchor.start), flat.length) : 0;
  const length = anchor ? Math.max(flatOffset(anchor.end) - at, 0) : 0;
  let start = at - WINDOW > SLACK ? at - WINDOW : 0;
  let end = flat.length - (at + length + WINDOW) > SLACK ? at + length + WINDOW : flat.length;
  if (start > 0) {
    const space = flat.indexOf(" ", start);
    if (space >= 0 && space < at) start = space + 1;
  }
  if (end < flat.length) {
    const space = flat.lastIndexOf(" ", end);
    if (space > at + length) end = space;
  }
  const cutStart = start > 0;
  const cutEnd = end < flat.length;
  return {
    text: `${cutStart ? "…" : ""}${flat.slice(start, end)}${cutEnd ? "…" : ""}`,
    whole: !cutStart && !cutEnd,
  };
}
