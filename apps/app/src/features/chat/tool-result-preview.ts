import { plural, t } from "@lingui/core/macro";

import type { JsonValue } from "@meridian/contracts/protocol";
import type { ContextPassageAnchor } from "./ChatContextNavigation";

export type ExcerptSpan = {
  lead: string;
  match: string;
  trail: string;
  clipped: boolean;
};

export type ToolResultRow = { kind: "document"; uri: string } | { kind: "folder"; uri: string };

export type GrepPassage = {
  excerpt: ExcerptSpan;
  passage?: ContextPassageAnchor;
};

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

export type GrepResultRows = CappedList<GrepHitRow> & {
  matches: number;
  exact: boolean;
};

export const LISTING_CAP = 8;

export function capList<T>(items: readonly T[], cap: number): CappedList<T> {
  return { rows: items.slice(0, cap), total: items.length };
}

type RowSpec<T> = {
  cap: number;
  toRow: (entry: Record<string, JsonValue>) => T | null;
};

const GREP_CAP = 4;
const LISTING: RowSpec<ToolResultRow> = { cap: LISTING_CAP, toRow: listingEntry };

export function normalizeGrepResult(output: JsonValue | undefined): GrepResultRows {
  if (!isRecord(output)) return { rows: [], total: 0, matches: 0, exact: true };
  const files = normalizeEntries(output.files, { cap: GREP_CAP, toRow: grepHit });
  const total = Math.max(
    typeof output.totalFiles === "number" ? output.totalFiles : files.total,
    files.total,
  );
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

export function normalizeListing(output: JsonValue | undefined): ToolResultRows {
  return normalizeEntries(isRecord(output) ? output.entries : undefined, LISTING);
}

function normalizeEntries<T>(output: JsonValue | undefined, spec: RowSpec<T>): CappedList<T> {
  return Array.isArray(output) ? capped(output, spec) : { rows: [], total: 0 };
}

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

function matchAnchor(match: Record<string, JsonValue>): { start: number; end: number } | null {
  const anchor = match.anchor;
  if (!isRecord(anchor) || typeof anchor.start !== "number" || typeof anchor.end !== "number")
    return null;
  return anchor.end > anchor.start ? { start: anchor.start, end: anchor.end } : null;
}

const LEAD_BUDGET = 40;

function excerptAround(text: string, anchor: { start: number; end: number } | null): ExcerptSpan {
  if (!anchor || anchor.end > text.length)
    return { lead: text, match: "", trail: "", clipped: false };

  const fullLead = text.slice(0, anchor.start);
  const clipped = fullLead.length > LEAD_BUDGET;
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

export function boundLabel<T>({
  rows,
  total,
  exact = true,
}: CappedList<T> & { exact?: boolean }): string | null {
  if (total <= rows.length) return null;
  const shown = rows.length;
  return exact ? t`${shown} of ${total}` : t`${shown} of at least ${total}`;
}

export function grepCardSummary({ exact, matches, total: documents }: GrepResultRows): string {
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

export function moreMatchesLabel(count: number): string {
  return plural(count, { one: "# more", other: "# more" });
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}
