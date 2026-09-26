/** Parses tool outputs into bounded, writer-facing previews. */
import { plural, t } from "@lingui/core/macro";

import type { JsonValue } from "@meridian/contracts/protocol";
import type { ContextPassageAnchor } from "./ChatContextNavigation";

export type ExcerptSpan = {
  lead: string;
  /** The match in the document's own casing, empty when the pattern is unknown. */
  match: string;
  trail: string;
  /** Lead-in was cut, so the row prints a leading ellipsis. */
  clipped: boolean;
};

export type ToolResultRow =
  /** A document the tool listed. Its name opens it. */
  | { kind: "document"; uri: string }
  /** A folder in a listing. Never a door: folders are not documents. */
  | { kind: "folder"; uri: string };

/** One passage a search matched. */
export type SearchPassage = {
  excerpt: ExcerptSpan;
  passage?: ContextPassageAnchor;
};

/** One document a search matched. */
export type SearchHitRow = {
  uri: string;
  passages: [SearchPassage, ...SearchPassage[]];
  matchCount: number;
};

export type CappedList<T> = {
  rows: T[];
  total: number;
};

export type ToolResultRows = CappedList<ToolResultRow>;

/** A capped list of documents plus what the search found across all of them. */
export type SearchResultRows = CappedList<SearchHitRow> & { matches: number };

export const LISTING_CAP = 8;

/** Cut a discrete list to its cap, keeping the size it was cut from. */
export function capList<T>(items: readonly T[], cap: number): CappedList<T> {
  return { rows: items.slice(0, cap), total: items.length };
}

type RowSpec<T> = {
  /** How many rows fit before the list has to report the rest as a count. */
  cap: number;
  toRow: (entry: Record<string, JsonValue>) => T | null;
};

/** A section each (name, count, a passage or three), so fewer fit than a bare listing. */
const SEARCH_CAP = 4;
const LISTING: RowSpec<ToolResultRow> = { cap: LISTING_CAP, toRow: listingEntry };

export function normalizeSearchHits(
  output: JsonValue | undefined,
  pattern?: string,
): SearchResultRows {
  const list = normalizeEntries(output, {
    cap: SEARCH_CAP,
    toRow: (row) => searchHit(row, pattern),
  });
  return { ...list, matches: totalMatches(output) };
}

function totalMatches(output: JsonValue | undefined): number {
  if (!Array.isArray(output)) return 0;
  let total = 0;
  for (const entry of output) {
    if (!isRecord(entry) || typeof entry.matchCount !== "number" || entry.matchCount < 1) return 0;
    total += entry.matchCount;
  }
  return total;
}

/** What `ls` returned: the folders and documents the model was shown. */
export function normalizeListing(output: JsonValue | undefined): ToolResultRows {
  return normalizeEntries(output, LISTING);
}

function normalizeEntries<T>(output: JsonValue | undefined, spec: RowSpec<T>): CappedList<T> {
  return Array.isArray(output) ? capped(output, spec) : { rows: [], total: 0 };
}

/** Takes rows until the cap is full, so a long payload is never fully walked. */
function capped<T>(entries: readonly JsonValue[], spec: RowSpec<T>): CappedList<T> {
  const rows: T[] = [];
  for (const entry of entries) {
    if (rows.length === spec.cap) break;
    if (!isRecord(entry)) continue;
    const row = spec.toRow(entry);
    if (row) rows.push(row);
  }
  return { rows, total: entries.length };
}

function isRecord(value: JsonValue): value is Record<string, JsonValue> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** One document's section of the result card. */
function searchHit(row: Record<string, JsonValue>, pattern?: string): SearchHitRow | null {
  if (typeof row.uri !== "string" || !Array.isArray(row.matches)) return null;
  if (typeof row.matchCount !== "number" || row.matchCount < 1) return null;
  const passages: SearchPassage[] = [];
  for (const match of row.matches) {
    if (!isRecord(match) || typeof match.excerpt !== "string") continue;
    passages.push({
      excerpt: excerptAround(match.excerpt, pattern),
      ...(typeof match.blockHash === "string" && match.blockHash && pattern
        ? { passage: { blockHash: match.blockHash, term: pattern } }
        : {}),
    });
  }
  const [best, ...rest] = passages;
  if (!best) return null;
  return { uri: row.uri, passages: [best, ...rest], matchCount: row.matchCount };
}

/** How much run-up to a match the row keeps before it cuts and marks the cut. */
const LEAD_BUDGET = 40;

function excerptAround(text: string, pattern?: string): ExcerptSpan {
  const index = pattern ? text.toLowerCase().indexOf(pattern.toLowerCase()) : -1;
  if (index < 0 || !pattern) return { lead: text, match: "", trail: "", clipped: false };

  const fullLead = text.slice(0, index);
  const clipped = fullLead.length > LEAD_BUDGET;
  // Cut on a word boundary: a passage that opens mid-word reads as damage
  // rather than as an excerpt.
  const lead = clipped
    ? fullLead.slice(fullLead.length - LEAD_BUDGET).replace(/^\S*\s+/, "")
    : fullLead;
  return {
    lead,
    match: text.slice(index, index + pattern.length),
    trail: text.slice(index + pattern.length),
    clipped,
  };
}

function listingEntry(row: Record<string, JsonValue>): ToolResultRow | null {
  if (typeof row.uri !== "string") return null;
  if (row.kind === "directory") return { kind: "folder", uri: row.uri };
  if (row.kind === "file") return { kind: "document", uri: row.uri };
  return null;
}

/** `4 of 42` — a fact about the payload, never an invitation to see more. */
export function boundLabel<T>({ rows, total }: CappedList<T>): string | null {
  if (total <= rows.length) return null;
  const shown = rows.length;
  return t`${shown} of ${total}`;
}

/** The card's header: what this search found, and nothing else. */
export function searchCardSummary(results: SearchResultRows): string {
  const documents = results.total;
  if (results.matches <= documents) {
    return plural(documents, { one: "# document", other: "# documents" });
  }
  const matches = results.matches;
  const inDocuments = plural(documents, { one: "# document", other: "# documents" });
  return t`${matches} results in ${inDocuments}`;
}

export function matchCountLabel(count: number): string {
  return plural(count, { one: "# match", other: "# matches" });
}

/** `and 2 more` — the passages the server sent but the section keeps folded. */
export function moreMatchesLabel(count: number): string {
  return plural(count, { one: "# more", other: "# more" });
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}
