/**
 * The `search` result (D65): the typed hits the handler returns, and the text
 * the model reads of them. Each file is its URI, then one `hash|excerpt` line
 * per passage, as `read` prints blocks, so the hash targets `read` and
 * `write`. The excerpt is a window around the match; `verbose` gives the whole
 * block. The app's previews and compaction read the typed hits.
 */
import { toHashline } from "@meridian/agent-edit";
import type { JsonObject, JsonValue } from "@meridian/contracts/threads";

/** One passage of a hit. `anchor` is where its first match sits in `excerpt`; old results have none. */
export interface SearchPassage {
  excerpt: string;
  blockHash?: string;
  anchor?: { start: number; end: number };
}

export interface SearchHit {
  uri: string;
  matches: SearchPassage[];
  matchCount: number;
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
  const verbose = input.verbose === true;
  return hits
    .map((hit) => {
      const notes = [
        hit.matchCount > hit.matches.length ? matches(hit.matchCount) : undefined,
        hit.readonly ? "read-only" : undefined,
      ].filter((note) => note !== undefined);
      const head = notes.length > 0 ? `${hit.uri} (${notes.join(", ")})` : hit.uri;
      if (cleared(hit)) return `${head}\n${CLEARED_SEARCH_PASSAGES}`;
      const passages = hit.matches.map((passage) => {
        const { text } = searchPassage(passage, verbose);
        return passage.blockHash ? toHashline(passage.blockHash, text) : text;
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
 * One passage as the model receives it, and whether that text shows its whole
 * block. Shown-link evidence keys on `whole` from this same call, so a link the
 * window cut through or left out is never claimed as shown.
 */
export function searchPassage(
  passage: SearchPassage,
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
function around({ excerpt, anchor }: SearchPassage): { text: string; whole: boolean } {
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
