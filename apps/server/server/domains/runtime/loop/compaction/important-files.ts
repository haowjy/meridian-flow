/** Model-ranked document selections a compaction re-shows, within its token budget. */
import {
  type ReadToolInput,
  ReadToolInputSchema,
  splitDocumentFile,
} from "@meridian/agent-edit/integration";
import { documentPathKey, parseContextUri } from "@meridian/contracts";
import type { DocumentRevisionEvidence, ReferenceOccurrence } from "@meridian/contracts/protocol";
import type { JsonObject } from "@meridian/contracts/threads";
import type { TokenizerFamily } from "../../gateway/index.js";
import { modelToolSchema } from "../../tools/model-tool-schema.js";
import type { RecordedDocuments } from "./elide.js";
import { estimateModelPartTokens } from "./estimate.js";

const KEEP_OPEN_HEADING = "## Documents to keep open";
const RECENT_DOCUMENTS_COUNT = 3;

export const KEEP_OPEN_INSTRUCTION_LINES = [
  KEEP_OPEN_HEADING,
  "End the summary with this section: one JSON object of ordinary read arguments per line, most important first. No tool calls or code fences.",
  "Use the read tool's arguments exactly, including path, selectors, format and version. Name only documents this conversation showed. Leave the section empty if none apply.",
  "The read input schema is:",
  JSON.stringify(modelToolSchema(ReadToolInputSchema)),
  "Failed or oversized reads are omitted, never retried with different arguments. The server replaces this list with the reads it actually re-shows.",
  "",
  "Example:",
  '{"path":"scratch://@c12/plan"}',
  '{"path":"manuscript://Chapter 1#the-duel"}',
  '{"path":"manuscript://Chapter 2","in":"2194"}',
  '{"path":"manuscript://Chapter 3","in":[40,95]}',
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

/** A validated read, pinned to the shown document rather than just its current path. */
interface ImportantFileCandidate {
  documentId: string;
  uri: string;
  input: ReadToolInput;
}

/** JSONB reorders object keys; pricing and replay must label the same input byte-for-byte. */
export function readInputLabel(input: JsonObject): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(input).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    ),
  );
}

/** Exact projected text, shared with budget estimation. Saved input is display-only on replay. */
export function importantFileText(input: JsonObject, text: string): string {
  return `Read result for ${readInputLabel(input)}, re-shown after the summary:\n${text}`;
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

/** Model-listed shown URIs first, then the three most recent documents, deduplicated by id. */
export function importantFileCandidates(
  recorded: RecordedDocuments,
  listedLines: readonly string[],
): { candidates: ImportantFileCandidate[]; unknownUriCount: number } {
  const newestFirst = [...recorded.values()]
    .reverse()
    .flatMap((refs) => [...(refs ?? [])].reverse());
  const byUri = new Map<string, DocumentRevisionEvidence>();
  const recent: ImportantFileCandidate[] = [];
  const recentIds = new Set<string>();
  for (const ref of newestFirst) {
    if (!ref.uri) continue;
    if (!byUri.has(ref.uri)) byUri.set(ref.uri, ref);
    if (recentIds.has(ref.documentId)) continue;
    recentIds.add(ref.documentId);
    if (recent.length < RECENT_DOCUMENTS_COUNT)
      recent.push({ documentId: ref.documentId, uri: ref.uri, input: { path: ref.uri } });
  }
  const seen = new Set<string>();
  const candidates: ImportantFileCandidate[] = [];
  let unknownUriCount = 0;
  for (const line of listedLines) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      unknownUriCount++;
      continue;
    }
    const path = value && typeof value === "object" && "path" in value ? value.path : undefined;
    if (typeof path !== "string") {
      unknownUriCount++;
      continue;
    }
    const { filePath, fragment } = splitDocumentFile(path);
    const parsedUri = parseContextUri(documentPathKey(filePath));
    const ref = parsedUri.ok ? byUri.get(parsedUri.value.normalized) : undefined;
    if (!ref?.uri) {
      unknownUriCount++;
      continue;
    }
    // An identifiable invalid request must not return as a recent whole read either.
    const duplicate = seen.has(ref.documentId);
    seen.add(ref.documentId);
    const parsed = ReadToolInputSchema.safeParse(value);
    if (!parsed.success) {
      unknownUriCount++;
      continue;
    }
    if (!duplicate)
      candidates.push({
        documentId: ref.documentId,
        uri: ref.uri,
        input: { ...parsed.data, path: ref.uri + (fragment === undefined ? "" : `#${fragment}`) },
      });
  }
  for (const candidate of recent) {
    if (seen.has(candidate.documentId)) continue;
    seen.add(candidate.documentId);
    candidates.push(candidate);
  }
  return { candidates, unknownUriCount };
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
 * whose selected text does not fit the remaining budget is skipped, never
 * truncated: a truncated copy would be a partial read with its own listing.
 * `read` answers null for a document that cannot be read.
 */
export async function chooseImportantFiles<T extends { text: string }>(input: {
  candidates: readonly ImportantFileCandidate[];
  budgetTokens: number;
  tokenizer: TokenizerFamily;
  read: (
    reference: Extract<ReferenceOccurrence, { kind: "document" }>,
    input: ReadToolInput,
  ) => Promise<T | null>;
}): Promise<
  {
    reference: Extract<ReferenceOccurrence, { kind: "document" }>;
    input: ReadToolInput;
    read: T;
  }[]
> {
  // The rewritten list is part of the summary: reserve the longest one it can become.
  const listTokens = estimateModelPartTokens(
    {
      type: "text",
      text: `\n\n${documentsSection(input.candidates.map((candidate) => readInputLabel(candidate.input)))}`,
    },
    input.tokenizer,
  );
  let remaining = Math.max(0, input.budgetTokens - listTokens);
  const kept: {
    reference: Extract<ReferenceOccurrence, { kind: "document" }>;
    input: ReadToolInput;
    read: T;
  }[] = [];
  for (const candidate of input.candidates) {
    // Nothing more can fit; the list stops where the reads stopped.
    if (remaining <= 0) break;
    const uri = candidate.uri;
    const reference: Extract<ReferenceOccurrence, { kind: "document" }> = {
      type: "reference",
      kind: "document",
      documentId: candidate.documentId,
      uri,
      text: uri,
    };
    const read = await input.read(reference, candidate.input);
    if (!read) continue;
    const tokens = estimateModelPartTokens(
      { type: "text", text: importantFileText(candidate.input, read.text) },
      input.tokenizer,
    );
    if (tokens > remaining) continue;
    remaining -= tokens;
    kept.push({ reference, input: candidate.input, read });
  }
  return kept;
}
