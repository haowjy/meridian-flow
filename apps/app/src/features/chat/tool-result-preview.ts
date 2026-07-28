/**
 * Pure, i18n-aware helpers for curated tool-result rows and bounded preview
 * text. Owns only display formatting.
 *
 * One parser per payload the timeline knows how to read. Each stops at its own
 * cap, which is what lets a closed row ask "is there anything behind this
 * chevron?" without paying for the whole list, and each answers that question
 * with the same code that fills the expand, so the two can't disagree.
 *
 * **The caller picks the parser, because the caller knows the tool.** A search
 * hit and a listing entry are both `{uri, …}` objects, and guessing which one a
 * payload holds by looking at its first recognizable entry throws away every
 * later row that disagrees with the guess. Tool identity selects the parser;
 * the row's own discriminant then selects how it renders.
 *
 * Rows say what they *are* rather than carrying a string the renderer has to
 * sniff: a document's name is a door, a folder's name is not, and only the
 * parser knows which it just read.
 *
 * Snippets arrive as prose. A block hash is how the model addresses a block, it
 * is not a word, and it travels in its own field rather than glued to the text
 * a writer reads, so nothing here has to know the hashline format to render a
 * sentence. This is the seam where a tool payload becomes a line of the
 * writer's book.
 */
import { plural, t } from "@lingui/core/macro";

import type { JsonValue } from "@meridian/contracts/protocol";
import type { ContextPassageAnchor } from "./ChatContextNavigation";

/**
 * A matched passage, split so the row can weight the match itself. Centred on
 * the match rather than started at the line's beginning: what the writer is
 * looking for is the word they searched, not the paragraph's opening.
 */
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

/**
 * One passage a search matched. The anchor is present only when the passage
 * can actually be navigated to — a hash to find the block, and the term that
 * verifies it is still the passage that matched. Without both, the excerpt is
 * quoted prose and the document's own name is the only door.
 */
export type SearchPassage = {
  excerpt: ExcerptSpan;
  passage?: ContextPassageAnchor;
};

/**
 * One document a search matched. `matchCount` counts the whole document, while
 * `passages` holds only what the server sent — the count is what stays honest
 * about the difference.
 *
 * Both are guaranteed here rather than guarded downstream: a hit with no
 * passage has nothing to show, and a hit that cannot say how much it found
 * cannot fill its badge. Either one is a malformed payload, and the honest
 * place to refuse it is the boundary that reads it.
 */
export type SearchHitRow = {
  uri: string;
  passages: [SearchPassage, ...SearchPassage[]];
  matchCount: number;
};

/**
 * A discrete list, cut to what fits, plus what it was cut from. `total` counts
 * every entry the tool returned, including ones too malformed to render: the
 * writer is being told the size of the payload, not the size of what we could
 * parse.
 */
export type CappedList<T> = {
  rows: T[];
  total: number;
};

export type ToolResultRows = CappedList<ToolResultRow>;

/**
 * A capped list of documents plus what the search found across all of them.
 * `matches` is 0 when the payload holds an entry that cannot say, which is
 * what keeps the card's header from claiming a total it cannot stand behind.
 */
export type SearchResultRows = CappedList<SearchHitRow> & { matches: number };

/**
 * One line per entry, so this is what fits before a list starts crowding the
 * transcript. Shared by `ls` listings and skim outlines, which are the same
 * shape of thing.
 */
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

/**
 * What `search` returned: one document per hit, with the passage it matched. The
 * pattern comes from the tool input so the row can find the match inside the
 * line and weight it.
 */
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

/**
 * Sums per-document counts across the WHOLE payload, unlike the row parse,
 * which stops at the cap: "12 results in 3 documents" is a claim about the
 * search, not about the four rows that fit. Reading one number per entry is
 * cheap; building a row is not.
 *
 * Zero when any entry declines to count, because a partial sum stated as a
 * total is worse than not stating one.
 */
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

/**
 * One document's section of the result card.
 *
 * The hash is never shown and always carried. It arrives in its own field and
 * the excerpt arrives as prose, so neither has to be parsed out of the other.
 * A passage without a hash (every scheme but manuscript) still reads; it just
 * cannot promise a destination, and the document's own name remains the door.
 */
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

/**
 * An `ls` entry. `kind` picks the glyph and decides door versus plain text;
 * it routes nothing, because no folder route exists to route to.
 */
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

/**
 * The card's header: what this search found, and nothing else. It never
 * repeats the query, because the row title directly above already says it.
 *
 * Results and documents are equal whenever every document matched once, and
 * stating both would say the same thing twice, so the header drops to the
 * document count alone. How many documents were *shown* is a different fact
 * and belongs to the bound line.
 */
export function searchCardSummary(results: SearchResultRows): string {
  const documents = results.total;
  if (results.matches <= documents) {
    return plural(documents, { one: "# document", other: "# documents" });
  }
  const matches = results.matches;
  const inDocuments = plural(documents, { one: "# document", other: "# documents" });
  return t`${matches} results in ${inDocuments}`;
}

/**
 * What a count badge means, for anyone who hears the card rather than sees it.
 * The badge itself is the bare number: it sits in a column, and a column reads
 * by shape.
 */
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
