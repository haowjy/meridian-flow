/** Model-ranked documents a compaction re-shows in full, within its token budget. */
import type { DocumentRevisionEvidence, ReferenceOccurrence } from "@meridian/contracts/protocol";
import type { TokenizerFamily } from "../../gateway/index.js";
import type { RecordedDocuments } from "./elide.js";
import { estimateModelPartTokens } from "./estimate.js";

export const NOT_RESHOWN_HEADING = "## Documents not re-shown";
const KEEP_OPEN_HEADING = "## Documents to keep open";
const LISTED_DOCUMENTS_MAX = 10;
const RECENT_DOCUMENTS_COUNT = 3;

export const KEEP_OPEN_INSTRUCTION_LINES = [
  KEEP_OPEN_HEADING,
  `End the summary with this section: one context URI per line, most important first, at most ${LISTED_DOCUMENTS_MAX}.`,
  "List only documents this conversation showed that are most important to read again in full. Leave the section empty if none apply.",
  `Do not carry forward an earlier summary's ${NOT_RESHOWN_HEADING} section; the server replaces it for this compaction.`,
  "Example:",
  "manuscript://Chapter 1.md",
  "scratch://@/c12/plan.md",
];

/** Remove both server-directed sections, even when followed by another summary section. */
export function parseImportantFiles(text: string): { summary: string; listedLines: string[] } {
  const summary: string[] = [];
  const listedLines: string[] = [];
  let section: "keep" | "omit" | null = null;
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed === KEEP_OPEN_HEADING || trimmed === NOT_RESHOWN_HEADING) {
      section = trimmed === KEEP_OPEN_HEADING ? "keep" : "omit";
      continue;
    }
    if (/^##\s/u.test(trimmed)) section = null;
    if (section === null) summary.push(line);
    if (section !== "keep") continue;
    const cleaned = trimmed
      .replace(/^(?:[-*]|\d+\.)\s+/u, "")
      .replace(/^[`<]+|[`>]+(?=\s|$)/gu, "")
      .trim();
    if (cleaned) listedLines.push(cleaned);
  }
  return { summary: summary.join("\n").trim(), listedLines };
}

/** The exact text projected for a re-shown read, shared with its budget estimate. */
export function importantFileText(uri: string, text: string): string {
  return `Current text of ${uri}, re-shown after the summary:\n${text}`;
}

const IMPORTANT_FILES_MAX_TOKENS = 20_000;
const IMPORTANT_FILES_WINDOW_FRACTION = 0.1;
/** Reserve for the not-re-shown note and request-envelope estimation slack. */
const TRIGGER_MARGIN_TOKENS = 1_000;

/**
 * Tokens the re-shown documents may add: a fraction of the window, capped, and never more than
 * the headroom the successor has under the auto-compaction trigger. The successor then cannot
 * land over the trigger, which would compact again at the next boundary.
 */
export function reshowBudgetTokens(input: {
  usableWindowTokens: number;
  triggerTokens: number | null;
  baseTokens: number;
}): number {
  const headroom =
    input.triggerTokens === null
      ? Number.POSITIVE_INFINITY
      : input.triggerTokens - input.baseTokens - TRIGGER_MARGIN_TOKENS;
  return Math.max(
    0,
    Math.min(
      IMPORTANT_FILES_MAX_TOKENS,
      Math.floor(input.usableWindowTokens * IMPORTANT_FILES_WINDOW_FRACTION),
      headroom,
    ),
  );
}

/** Model-listed shown URIs first, then the three most recent documents, deduplicated by id. */
export function importantFileCandidates(
  recorded: RecordedDocuments,
  listedLines: readonly string[],
): { candidates: DocumentRevisionEvidence[]; unknownUriCount: number } {
  const newestFirst = [...recorded.values()]
    .reverse()
    .flatMap((refs) => [...(refs ?? [])].reverse());
  const byUri = new Map<string, DocumentRevisionEvidence>();
  const recent: DocumentRevisionEvidence[] = [];
  const recentIds = new Set<string>();
  for (const ref of newestFirst) {
    if (!ref.uri) continue;
    if (!byUri.has(ref.uri)) byUri.set(ref.uri, ref);
    if (recentIds.has(ref.documentId)) continue;
    recentIds.add(ref.documentId);
    if (recent.length < RECENT_DOCUMENTS_COUNT) recent.push(ref);
  }
  const shownUris = [...byUri.keys()].sort((a, b) => b.length - a.length);
  const listed = listedLines.flatMap((line) => {
    const uri = shownUris.find(
      (shown) =>
        line.startsWith(shown) &&
        (line.length === shown.length || /^[\s\p{P}<>]/u.test(line.slice(shown.length))),
    );
    const ref = uri === undefined ? undefined : byUri.get(uri);
    return ref ? [ref] : [];
  });
  const seen = new Set<string>();
  const candidates = [...listed.slice(0, LISTED_DOCUMENTS_MAX), ...recent].filter((ref) => {
    if (seen.has(ref.documentId)) return false;
    seen.add(ref.documentId);
    return true;
  });
  return { candidates, unknownUriCount: listedLines.length - listed.length };
}

/**
 * Reads every candidate in priority order. A document
 * whose full text does not fit the remaining budget is skipped, never
 * truncated: a truncated copy would be a partial read with its own listing.
 * `read` answers null for a document that cannot be read.
 */
export async function chooseImportantFiles<T extends { text: string }>(input: {
  candidates: readonly DocumentRevisionEvidence[];
  budgetTokens: number;
  tokenizer: TokenizerFamily;
  read: (reference: ReferenceOccurrence) => Promise<T | null>;
}): Promise<{ reference: ReferenceOccurrence; read: T }[]> {
  let remaining = input.budgetTokens;
  const kept: { reference: ReferenceOccurrence; read: T }[] = [];
  for (const candidate of input.candidates) {
    const uri = candidate.uri as string;
    const reference: ReferenceOccurrence = {
      type: "reference",
      documentId: candidate.documentId,
      uri,
      text: uri,
    };
    const read = await input.read(reference);
    if (!read) continue;
    const tokens = estimateModelPartTokens(
      { type: "text", text: importantFileText(uri, read.text) },
      input.tokenizer,
    );
    if (tokens > remaining) continue;
    remaining -= tokens;
    kept.push({ reference, read });
  }
  return kept;
}
