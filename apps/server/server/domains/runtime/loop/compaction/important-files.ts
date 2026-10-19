/**
 * The documents a compaction re-shows in full after its summary (C10): the ones
 * the conversation's results showed most recently, within a document count and
 * a token budget. A summary cannot credit the model with having seen a
 * document; the re-shown current text can.
 */
import type { DocumentRevisionEvidence, ReferenceOccurrence } from "@meridian/contracts/protocol";
import type { RecordedDocuments } from "./elide.js";

export const IMPORTANT_FILES_MAX = 5;
const IMPORTANT_FILES_MAX_TOKENS = 20_000;
const IMPORTANT_FILES_WINDOW_FRACTION = 0.1;
/** Compaction estimates text at 3 bytes per token wherever it lacks a tokenizer. */
const BYTES_PER_TOKEN = 3;
/** Skipped documents still cost a read, so the search for five that fit stops here. */
const IMPORTANT_FILES_MAX_READS = 2 * IMPORTANT_FILES_MAX;

/** Documents in `recorded` (history order), most recently shown first, one entry per document. */
export function importantFileCandidates(recorded: RecordedDocuments): DocumentRevisionEvidence[] {
  const seen = new Set<string>();
  const candidates: DocumentRevisionEvidence[] = [];
  for (const refs of [...recorded.values()].reverse()) {
    for (const ref of [...(refs ?? [])].reverse()) {
      if (!ref.uri || seen.has(ref.documentId)) continue;
      seen.add(ref.documentId);
      candidates.push(ref);
    }
  }
  return candidates;
}

/**
 * Reads candidates in order until `IMPORTANT_FILES_MAX` are kept. A document
 * whose full text does not fit the remaining budget is skipped, never
 * truncated: a truncated copy would be a partial read with its own listing.
 * `read` answers null for a document that cannot be read.
 */
export async function chooseImportantFiles<T extends { text: string }>(input: {
  candidates: readonly DocumentRevisionEvidence[];
  usableWindowTokens: number;
  read: (reference: ReferenceOccurrence) => Promise<T | null>;
}): Promise<{ reference: ReferenceOccurrence; read: T }[]> {
  let remaining = Math.min(
    IMPORTANT_FILES_MAX_TOKENS,
    Math.floor(input.usableWindowTokens * IMPORTANT_FILES_WINDOW_FRACTION),
  );
  const kept: { reference: ReferenceOccurrence; read: T }[] = [];
  for (const candidate of input.candidates.slice(0, IMPORTANT_FILES_MAX_READS)) {
    if (kept.length === IMPORTANT_FILES_MAX) break;
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
