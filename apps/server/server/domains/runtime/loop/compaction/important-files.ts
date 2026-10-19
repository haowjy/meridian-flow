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
    const heading = trimmed
      .match(/^#{1,6}\s+(.+?)\s*$/u)?.[1]
      ?.replace(/[\s:#]+$/u, "")
      .trim()
      .toLowerCase();
    if (heading === "documents to keep open" || heading === "documents not re-shown") {
      section = heading === "documents to keep open" ? "keep" : "omit";
      continue;
    }
    if (/^#{1,6}\s/u.test(trimmed)) section = null;
    if (section === null) summary.push(line);
    if (section !== "keep") continue;
    let cleaned = trimmed.replace(/^(?:[-*+]|\d+[.)])\s+/u, "").trim();
    // Strip only surrounding decoration, never a suffix that could be part of a URI.
    const wrappers: Record<string, string> = { "`": "`", "<": ">", '"': '"', "'": "'" };
    let previous: string;
    do {
      previous = cleaned;
      cleaned = cleaned
        .replace(/[.,;:]+$/u, "")
        .replace(/\s+\([^()]*\)$/u, "")
        .trim();
      const closing = wrappers[cleaned[0] ?? ""];
      if (closing && cleaned.endsWith(closing)) cleaned = cleaned.slice(1, -1).trim();
    } while (cleaned !== previous);
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
/** Estimator slack only; the omission note is priced and reserved separately. */
const TRIGGER_MARGIN_TOKENS = 1_000;

/**
 * Budget for re-shown text and its omission note: a fraction of the window, capped by
 * headroom under the auto-compaction trigger. The picker reserves the note first; if the
 * mandatory note alone exceeds headroom, it is still written but no documents are admitted.
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
  const listed = listedLines.flatMap((line) => {
    const ref = byUri.get(line);
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

/** Current-attempt omission receipt, shared by projection and worst-case budget reservation. */
export function notReshownNote(uris: readonly string[]): string {
  if (!uris.length) return "";
  return [
    NOT_RESHOWN_HEADING,
    "These documents were not re-shown after the summary. Read them again before writing in them.",
    ...new Set(uris.map((uri) => `- ${uri}`)),
  ].join("\n");
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
  const note = notReshownNote(input.candidates.map((candidate) => candidate.uri as string));
  // Every kept document only shortens this note, so reserving all omissions is conservative.
  const noteTokens = note
    ? estimateModelPartTokens({ type: "text", text: `\n\n${note}` }, input.tokenizer)
    : 0;
  let remaining = Math.max(0, input.budgetTokens - noteTokens);
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
