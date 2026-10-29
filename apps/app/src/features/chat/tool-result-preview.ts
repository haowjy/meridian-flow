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

/** One passage a grep matched. */
export type GrepPassage = {
  excerpt: ExcerptSpan;
  passage?: ContextPassageAnchor;
};

/** One document a grep matched. `output_mode` decides what it carries: passages, a count, or neither. */
export type GrepHitRow = {
  uri: string;
  passages: GrepPassage[];
  matchCount?: number;
};

export type CappedList<T> = {
  rows: T[];
  total: number;
};

export type ToolResultRows = CappedList<ToolResultRow>;

/** A capped list of documents plus what the grep found across all of them. */
export type GrepResultRows = CappedList<GrepHitRow> & {
  matches: number;
  /** False when `total` is a lower bound: the server stopped counting or the scan stopped. */
  exact: boolean;
};

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
const GREP_CAP = 4;
const LISTING: RowSpec<ToolResultRow> = { cap: LISTING_CAP, toRow: listingEntry };

/** What `grep` returned (`{ files, totalFiles }`): the documents the model was shown. */
export function normalizeGrepResult(output: JsonValue | undefined): GrepResultRows {
  if (!isRecord(output)) return { rows: [], total: 0, matches: 0, exact: true };
  const files = normalizeEntries(output.files, { cap: GREP_CAP, toRow: grepHit });
  const total = Math.max(
    typeof output.totalFiles === "number" ? output.totalFiles : files.total,
    files.total,
  );
  // The model is sent at most `head_limit` files, so their match counts add up to a part of the
  // total; the header may state a match count only when the files sent are every file that matched.
  return {
    ...files,
    total,
    matches: total > files.total ? 0 : totalMatches(output.files),
    exact: output.exact !== false,
  };
}

function totalMatches(files: JsonValue | undefined): number {
  if (!Array.isArray(files)) return 0;
  let total = 0;
  for (const entry of files) {
    if (!isRecord(entry) || typeof entry.matchCount !== "number") return 0;
    total += entry.matchCount;
  }
  return total;
}

/** What `ls` returned (`{ uri, entries }`): the folders and documents the model was shown. */
export function normalizeListing(output: JsonValue | undefined): ToolResultRows {
  return normalizeEntries(isRecord(output) ? output.entries : undefined, LISTING);
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

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** One document's section of the result card. */
function grepHit(row: Record<string, JsonValue>): GrepHitRow | null {
  if (typeof row.uri !== "string" || !Array.isArray(row.matches)) return null;
  const passages: GrepPassage[] = [];
  for (const match of row.matches) {
    if (!isRecord(match) || typeof match.excerpt !== "string") continue;
    const anchor = matchAnchor(match);
    passages.push({
      excerpt: excerptAround(match.excerpt, anchor),
      ...(typeof match.blockHash === "string" && match.blockHash && anchor
        ? {
            passage: {
              blockHash: match.blockHash,
              term: typeof match.term === "string" ? match.term : "",
            },
          }
        : {}),
    });
  }
  return {
    uri: row.uri,
    passages,
    ...(typeof row.matchCount === "number" ? { matchCount: row.matchCount } : {}),
  };
}

/** Where the first match sits in the excerpt, as the server recorded it; results from before grep have none. */
function matchAnchor(match: Record<string, JsonValue>): { start: number; end: number } | null {
  const anchor = match.anchor;
  if (!isRecord(anchor) || typeof anchor.start !== "number" || typeof anchor.end !== "number")
    return null;
  return anchor.end > anchor.start ? { start: anchor.start, end: anchor.end } : null;
}

/** How much run-up to a match the row keeps before it cuts and marks the cut. */
const LEAD_BUDGET = 40;

function excerptAround(text: string, anchor: { start: number; end: number } | null): ExcerptSpan {
  if (!anchor || anchor.end > text.length)
    return { lead: text, match: "", trail: "", clipped: false };

  const fullLead = text.slice(0, anchor.start);
  const clipped = fullLead.length > LEAD_BUDGET;
  // Cut on a word boundary: a passage that opens mid-word reads as damage
  // rather than as an excerpt.
  const lead = clipped
    ? fullLead.slice(fullLead.length - LEAD_BUDGET).replace(/^\S*\s+/, "")
    : fullLead;
  return {
    lead,
    match: text.slice(anchor.start, anchor.end),
    trail: text.slice(anchor.end),
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
export function boundLabel<T>({
  rows,
  total,
  exact = true,
}: CappedList<T> & { exact?: boolean }): string | null {
  if (total <= rows.length) return null;
  const shown = rows.length;
  // A partial scan's total is a lower bound, as the card's header already says.
  return exact ? t`${shown} of ${total}` : t`${shown} of at least ${total}`;
}

/** The card's header: what this grep found, and nothing else. */
export function grepCardSummary({ exact, matches, total: documents }: GrepResultRows): string {
  // A scan that stopped early can only say it found at least this many.
  if (!exact && documents === 0) return t`No matches found before the search stopped`;
  const inDocuments = plural(documents, { one: "# document", other: "# documents" });
  if (matches <= documents)
    return exact
      ? inDocuments
      : plural(documents, { one: "At least # document", other: "At least # documents" });
  return exact
    ? t`${matches} results in ${inDocuments}`
    : t`At least ${matches} results in ${inDocuments}`;
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
