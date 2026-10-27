/**
 * The `grep` result (D65): the typed files the handler returns, and the text the model reads of
 * them. In `content` mode each file is its URI, then one `hash|excerpt` line per passage, as
 * `read` prints blocks, so the hash targets `read` and `write`; the excerpt is a window around
 * the match, and `verbose` gives the whole block. `files_with_matches` lists URIs and `count`
 * adds the number of matches. The app's previews and compaction read the typed files.
 */
import { toHashline } from "@meridian/agent-edit";
import type { JsonObject, JsonValue } from "@meridian/contracts/threads";

/** One passage of a hit. `anchor` is where its first match sits in `excerpt`. */
export interface GrepPassage {
  excerpt: string;
  blockHash?: string;
  anchor?: { start: number; end: number };
  /** The writer's text of that match, for the app's door; never shown to the model. */
  term?: string;
}

export interface GrepHit {
  uri: string;
  matches: GrepPassage[];
  /** Absent in `files_with_matches`. */
  matchCount?: number;
  /** True when the agent can't edit the file. */
  readonly?: boolean;
}

/** What the tool returns: the files, and how many matched in all. */
export interface GrepToolResult {
  files: GrepHit[];
  totalFiles: number;
  /** False when `totalFiles` is a lower bound, or the scan stopped before the last document. */
  exact: boolean;
}

/** Characters kept either side of the match. */
const WINDOW = 120;
/** A cut that would drop fewer characters than this keeps them instead. */
const SLACK = 24;

const CLEARED_GREP_PASSAGES =
  "[Cleared at compaction: changed since this grep; read it for current text]";

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

/**
 * The result as text. `cleared` files keep their URI and lose their passages,
 * for compaction (the planner decides which changed).
 */
export function renderGrepFiles(
  { files, totalFiles, exact }: GrepToolResult,
  input: JsonObject,
  cleared: (hit: GrepHit) => boolean = () => false,
): string {
  if (files.length === 0)
    return exact
      ? "No matches."
      : "No matches found before the search stopped. Narrow with path or glob.";
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
  return totalFiles > files.length || !exact
    ? `${body}\n\n${files.length} of ${exact ? "" : "at least "}${totalFiles} files. Narrow with path or glob, or raise head_limit.`
    : body;
}

/** Each file and how often it matched, with no passages: compaction's history form. */
export function renderGrepFileList({ files }: GrepToolResult): string {
  return [
    "[grep passages omitted; read a file for its current text]",
    ...files.map((hit) =>
      hit.matchCount === undefined ? hit.uri : `${hit.uri} (${matches(hit.matchCount)})`,
    ),
  ].join("\n");
}

function matches(count: number): string {
  return count === 1 ? "1 match" : `${count} matches`;
}

/**
 * One passage as the model receives it, and whether that text shows its whole
 * block. Shown-link evidence keys on `whole` from this same call, so a link the
 * window cut through or left out is never claimed as shown.
 */
export function grepPassage(
  passage: GrepPassage,
  verbose: boolean,
): { text: string; whole: boolean } {
  return verbose ? { text: passage.excerpt, whole: true } : around(passage);
}

/**
 * About {@link WINDOW} characters either side of the match, on one line, cut at
 * word boundaries and marked with `…`. A passage with no anchor (a result from
 * before grep) starts at the top. Flattening whitespace keeps every link whole,
 * so an uncut window shows them all.
 */
function around({ excerpt, anchor }: GrepPassage): { text: string; whole: boolean } {
  const flat = excerpt.replace(/\s+/gu, " ").trim();
  // The anchor is an offset into the unflattened excerpt; flatten its prefix to find it in `flat`.
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
