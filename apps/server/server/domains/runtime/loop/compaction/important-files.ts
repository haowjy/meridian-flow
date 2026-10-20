/** Model-ranked documents a compaction re-shows in full, within its token budget. */
import type { DocumentRevisionEvidence, ReferenceOccurrence } from "@meridian/contracts/protocol";
import type { TokenizerFamily } from "../../gateway/index.js";
import type { RecordedDocuments } from "./elide.js";
import { estimateModelPartTokens } from "./estimate.js";

const KEEP_OPEN_HEADING = "## Documents to keep open";
const RECENT_DOCUMENTS_COUNT = 3;

export const KEEP_OPEN_INSTRUCTION_LINES = [
  KEEP_OPEN_HEADING,
  "End the summary with this section: one context URI per line, most important first.",
  "List only documents this conversation showed that are most important to read again in full. Leave the section empty if none apply.",
  "The server replaces this list with the documents it actually re-shows; list what you need.",
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
    const item = trimmed.replace(/^(?:[-*+]|\d+[.)])\s+/u, "").trim();
    if (item) listedLines.push(item);
  }
  return { summary: summary.join("\n").trim(), listedLines };
}

/** The exact text projected for a re-shown read, shared with its budget estimate. */
export function importantFileText(uri: string, text: string): string {
  return `Current text of ${uri}, re-shown after the summary:\n${text}`;
}

/** Estimator slack only; the written list is priced and reserved separately. */
const TRIGGER_MARGIN_TOKENS = 1_000;

/**
 * Re-shown text and its list may use half the trigger headroom, less estimator slack.
 * The list can still exceed the budget on its own; it is then the only thing written.
 */
export function reshowBudgetTokens(input: {
  triggerTokens: number | null;
  baseTokens: number;
}): number {
  if (input.triggerTokens === null) return Number.POSITIVE_INFINITY;
  return Math.max(
    0,
    Math.floor((input.triggerTokens - input.baseTokens) / 2) - TRIGGER_MARGIN_TOKENS,
  );
}

const WRAPPERS: Record<string, string> = { "`": "`", "<": ">", '"': '"', "'": "'" };

/**
 * The shown document a listed line names. Decoration is peeled one layer at a time and the
 * shown set is checked before each peel, because a name can itself end in what looks like
 * decoration (`Chapter 1 (revised)`, `Notes.`). A line that never matches names nothing.
 */
function resolveListedUri<T>(line: string, byUri: ReadonlyMap<string, T>): T | undefined {
  let current = line;
  for (;;) {
    const ref = byUri.get(current);
    if (ref) return ref;
    const closing = WRAPPERS[current[0] ?? ""];
    const next = (
      closing && current.length > 1 && current.endsWith(closing)
        ? current.slice(1, -1)
        : /[.,;:]$/u.test(current)
          ? current.slice(0, -1)
          : current.replace(/\s+\([^()]*\)$/u, "")
    ).trim();
    if (next === current) return undefined;
    current = next;
  }
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
    const ref = resolveListedUri(line, byUri);
    return ref ? [ref] : [];
  });
  const seen = new Set<string>();
  const candidates = [...listed, ...recent].filter((ref) => {
    if (seen.has(ref.documentId)) return false;
    seen.add(ref.documentId);
    return true;
  });
  return { candidates, unknownUriCount: listedLines.length - listed.length };
}

/**
 * The documents the successor now holds, written back into the summary. Built
 * from the reads that were admitted, so the list and the blocks cannot disagree.
 */
export function documentsSection(labels: readonly string[]): string {
  if (!labels.length) return "";
  return [KEEP_OPEN_HEADING, ...labels.map((label) => `- ${label}`)].join("\n");
}

/**
 * Reads candidates in priority order until the budget is spent. A document
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
  // The rewritten list is part of the summary: reserve the longest one it can become.
  const listTokens = estimateModelPartTokens(
    {
      type: "text",
      text: `\n\n${documentsSection(input.candidates.map((candidate) => candidate.uri as string))}`,
    },
    input.tokenizer,
  );
  let remaining = Math.max(0, input.budgetTokens - listTokens);
  const kept: { reference: ReferenceOccurrence; read: T }[] = [];
  for (const candidate of input.candidates) {
    // Nothing more can fit; the list stops where the reads stopped.
    if (remaining <= 0) break;
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
