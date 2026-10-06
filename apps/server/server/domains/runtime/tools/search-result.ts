/**
 * The `search` result (D65): the typed hits the handler returns, and the text
 * the model reads of them. Each file is its URI, then one `hash|excerpt` line
 * per passage, as `read` prints blocks, so the hash targets `read` and
 * `write`. The excerpt is a window around the match; `verbose` gives the whole
 * block and the score. The app's previews and compaction read the typed hits.
 */
import { markdownPlainText, toHashline } from "@meridian/agent-edit";
import type { JsonObject, JsonValue } from "@meridian/contracts/threads";

export interface SearchHit {
  uri: string;
  matches: { excerpt: string; blockHash?: string }[];
  matchCount: number;
  score?: number;
  /** True when the agent can't edit the file. */
  readonly?: boolean;
}

/** Characters kept either side of the match. */
const WINDOW = 120;
/** A cut that would drop fewer characters than this keeps them instead. */
const SLACK = 24;

const CLEARED_SEARCH_PASSAGES =
  "[Cleared at compaction: changed since this search; read it for current text]";

export function isSearchHits(value: JsonValue | undefined): value is JsonObject[] {
  return (
    Array.isArray(value) &&
    value.every(
      (hit) =>
        typeof hit === "object" &&
        hit !== null &&
        !Array.isArray(hit) &&
        typeof hit.uri === "string" &&
        Array.isArray(hit.matches),
    )
  );
}

export function renderSearchResult(value: JsonValue, input: JsonObject): string {
  if (!isSearchHits(value)) return JSON.stringify(value);
  return renderSearchHits(value as unknown as SearchHit[], input);
}

/**
 * The hits as text. `cleared` hits keep their URI and lose their passages,
 * for compaction (the planner decides which changed).
 */
export function renderSearchHits(
  hits: readonly SearchHit[],
  input: JsonObject,
  cleared: (hit: SearchHit) => boolean = () => false,
): string {
  if (hits.length === 0) return "No matches.";
  const pattern = typeof input.pattern === "string" ? input.pattern : "";
  const verbose = input.verbose === true;
  return hits
    .map((hit) => {
      const notes = [
        hit.matchCount > hit.matches.length ? matches(hit.matchCount) : undefined,
        hit.readonly ? "read-only" : undefined,
        verbose && hit.score !== undefined ? `score ${hit.score.toFixed(2)}` : undefined,
      ].filter((note) => note !== undefined);
      const head = notes.length > 0 ? `${hit.uri} (${notes.join(", ")})` : hit.uri;
      if (cleared(hit)) return `${head}\n${CLEARED_SEARCH_PASSAGES}`;
      const passages = hit.matches.map(({ excerpt, blockHash }) => {
        const text = verbose ? excerpt : around(excerpt, pattern);
        return blockHash ? toHashline(blockHash, text) : text;
      });
      return [head, ...passages].join("\n");
    })
    .join("\n\n");
}

/** Each file and how often it matched, with no passages: compaction's history form. */
export function renderSearchFiles(hits: readonly SearchHit[]): string {
  return [
    "[search passages omitted; read a file for its current text]",
    ...hits.map((hit) => `${hit.uri} (${matches(hit.matchCount)})`),
  ].join("\n");
}

function matches(count: number): string {
  return count === 1 ? "1 match" : `${count} matches`;
}

/**
 * About {@link WINDOW} characters either side of the first match, on one line,
 * cut at word boundaries and marked with `…`. A block whose match can't be
 * located (the query matched its plain text, not its markdown) starts at the top.
 */
function around(excerpt: string, pattern: string): string {
  const flat = excerpt.replace(/\s+/gu, " ").trim();
  const lower = flat.toLowerCase();
  const needles = [pattern, markdownPlainText(pattern)].map((needle) => needle.toLowerCase());
  const needle = needles.find((candidate) => candidate && lower.includes(candidate)) ?? "";
  const at = needle ? lower.indexOf(needle) : 0;
  let start = at - WINDOW > SLACK ? at - WINDOW : 0;
  let end =
    flat.length - (at + needle.length + WINDOW) > SLACK ? at + needle.length + WINDOW : flat.length;
  if (start > 0) {
    const space = flat.indexOf(" ", start);
    if (space >= 0 && space < at) start = space + 1;
  }
  if (end < flat.length) {
    const space = flat.lastIndexOf(" ", end);
    if (space > at + needle.length) end = space;
  }
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}
