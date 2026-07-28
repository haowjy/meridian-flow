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
 * Snippets arrive as the model saw them, which for manuscript documents means
 * a leading block hash. Hashes are how the model addresses a block; they are
 * not words, and the writer never sees one. This is the seam where a tool
 * payload becomes a line of the writer's book.
 */
import { t } from "@lingui/core/macro";
import { stripBlockHash } from "@meridian/agent-edit";

import type { JsonValue } from "@meridian/contracts/protocol";

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
  /** A document the tool found or listed. Its name opens it. */
  | { kind: "document"; uri: string; excerpt?: ExcerptSpan }
  /** A folder in a listing. Never a door: folders are not documents. */
  | { kind: "folder"; uri: string };

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
 * One line per entry, so this is what fits before a list starts crowding the
 * transcript. Shared by `ls` listings and skim outlines, which are the same
 * shape of thing.
 */
export const LISTING_CAP = 8;

/** Cut a discrete list to its cap, keeping the size it was cut from. */
export function capList<T>(items: readonly T[], cap: number): CappedList<T> {
  return { rows: items.slice(0, cap), total: items.length };
}

type RowSpec = {
  /** How many rows fit before the list has to report the rest as a count. */
  cap: number;
  toRow: (entry: Record<string, JsonValue>) => ToolResultRow | null;
};

/** Two lines each (name, passage), so fewer of them fit than a bare listing. */
const SEARCH_CAP = 4;
const LISTING: RowSpec = { cap: LISTING_CAP, toRow: listingEntry };

/**
 * What `grep` returned: one document per hit, with the passage it matched. The
 * pattern comes from the tool input so the row can find the match inside the
 * line and weight it.
 */
export function normalizeSearchHits(
  output: JsonValue | undefined,
  pattern?: string,
): ToolResultRows {
  return normalizeEntries(output, {
    cap: SEARCH_CAP,
    toRow: (row) => searchHit(row, pattern),
  });
}

/** What `ls` returned: the folders and documents the model was shown. */
export function normalizeListing(output: JsonValue | undefined): ToolResultRows {
  return normalizeEntries(output, LISTING);
}

function normalizeEntries(output: JsonValue | undefined, spec: RowSpec): ToolResultRows {
  return Array.isArray(output) ? capped(output, spec) : { rows: [], total: 0 };
}

/** Takes rows until the cap is full, so a long payload is never fully walked. */
function capped(entries: readonly JsonValue[], spec: RowSpec): ToolResultRows {
  const rows: ToolResultRow[] = [];
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

function searchHit(row: Record<string, JsonValue>, pattern?: string): ToolResultRow | null {
  if (typeof row.uri !== "string" || typeof row.excerpt !== "string") return null;
  // `row.line` is deliberately dropped. Chapters are not line-addressed, and a
  // line number is developer vocabulary in a novelist's transcript.
  return {
    kind: "document",
    uri: row.uri,
    excerpt: excerptAround(stripBlockHash(row.excerpt), pattern),
  };
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

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}
