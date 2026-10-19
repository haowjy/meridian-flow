/** Model-ranked documents a compaction re-shows in full, within its token budget. */
import type { DocumentRevisionEvidence, ReferenceOccurrence } from "@meridian/contracts/protocol";
import type { RecordedDocuments } from "./elide.js";

const KEEP_OPEN_HEADING = "## Documents to keep open";
const LISTED_DOCUMENTS_MAX = 10;
const RECENT_DOCUMENTS_COUNT = 3;

export const KEEP_OPEN_INSTRUCTION_LINES = [
  KEEP_OPEN_HEADING,
  `End the summary with this section: one context URI per line, most important first, at most ${LISTED_DOCUMENTS_MAX}.`,
  "List only documents this conversation showed that are most important to read again in full. Leave the section empty if none apply.",
  "Example:",
  "manuscript://Chapter%201",
  "scratch://@/c12/plan.md",
];

/** Remove the machine-directed section, even when the model puts it before another section. */
export function parseImportantFiles(text: string): { summary: string; uris: string[] } {
  const lines = text.split(/\r?\n/u);
  const summary: string[] = [];
  const uris: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (line.trim() === KEEP_OPEN_HEADING) {
      inSection = true;
      continue;
    }
    if (/^##\s/u.test(line)) inSection = false;
    if (!inSection) {
      summary.push(line);
      continue;
    }
    const uri = line
      .match(/[a-z][a-z0-9+.-]*:\/\/[^\s`<>]+/iu)?.[0]
      .replace(/[.,;:!?)\]}'"]+$/u, "");
    if (uri) uris.push(uri);
  }
  return { summary: summary.join("\n").trim(), uris };
}

const IMPORTANT_FILES_MAX_TOKENS = 20_000;
const IMPORTANT_FILES_WINDOW_FRACTION = 0.1;
/** Compaction estimates text at 3 bytes per token wherever it lacks a tokenizer. */
const BYTES_PER_TOKEN = 3;

/** Estimation slack kept under the trigger: the budget counts bytes, the next request counts tokens. */
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
  listedUris: readonly string[],
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
  const listed = listedUris.flatMap((uri) => {
    const ref = byUri.get(uri);
    return ref ? [ref] : [];
  });
  const seen = new Set<string>();
  const candidates = [...listed.slice(0, LISTED_DOCUMENTS_MAX), ...recent].filter((ref) => {
    if (seen.has(ref.documentId)) return false;
    seen.add(ref.documentId);
    return true;
  });
  return { candidates, unknownUriCount: listedUris.length - listed.length };
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
    const tokens = Math.ceil(Buffer.byteLength(read.text, "utf8") / BYTES_PER_TOKEN);
    if (tokens > remaining) continue;
    remaining -= tokens;
    kept.push({ reference, read });
  }
  return kept;
}
