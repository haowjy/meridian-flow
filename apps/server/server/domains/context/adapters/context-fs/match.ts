/**
 * Per-document search matching: the passages a query hit, how to navigate back
 * to them, and how often the document holds it. Shared by the in-memory and
 * drizzle context stores so both report search hits identically.
 *
 * **A document reports several passages, not one.** One hit per document
 * under-reports what the model received and leaves the writer's expand showing
 * a single sentence for a chapter that mentions the name five times. The list
 * is capped because a search result is a way in, not the document itself; the
 * count beside it stays honest about everything the cap left out.
 *
 * The unit of the scan is a **block**, not a text line. Manuscript documents
 * arrive as hashlines (`hash|body`), where one entry is one block and a
 * multi-line block carries its own newlines; every other scheme arrives as
 * plain markdown lines, where the two coincide. Scanning per entry is what
 * lets a hit carry the block hash the writer's editor navigates to, and it
 * keeps the query away from the hash itself — a hash is hex, and hex spells
 * words often enough to over-report a count.
 *
 * **The hash leaves through its own field, never inside the excerpt.** A
 * passage carries the block's body; addressing and prose are separate values,
 * so nothing downstream has to know the hashline format to show a sentence to
 * a writer. Plain schemes are unaffected: their body is the whole entry.
 */
import { splitHashline } from "@meridian/agent-edit";

/** How many passages one document contributes before the count speaks for the rest. */
export const PASSAGE_CAP = 3;

/** One matched passage, as the model and the writer see it. */
export interface MatchedPassage {
  /** The matching block's text, with no addressing prefix on it. */
  excerpt: string;
  /**
   * Hash of the block this passage came from. Absent for schemes whose
   * documents carry no hashlines — that absence is the contract, not a
   * failure to parse.
   */
  blockHash?: string;
}

/** What one document contributed to a search. */
export interface DocumentMatch {
  /** Matching passages in document order, at most {@link PASSAGE_CAP}. */
  matches: MatchedPassage[];
  /** Occurrences of the query across the whole document. At least 1. */
  matchCount: number;
}

/**
 * Collect the first passages of `entries` containing `query`
 * (case-insensitive) and count every occurrence in the document. Returns null
 * when nothing matches.
 */
export function matchDocument(
  entries: readonly string[],
  query: string,
  options: { hashlines: boolean },
): DocumentMatch | null {
  const needle = query.toLowerCase();
  if (needle.length === 0) return null;

  const matches: MatchedPassage[] = [];
  let matchCount = 0;
  for (const entry of entries) {
    const parsed = options.hashlines ? splitHashline(entry) : null;
    const body = parsed?.body ?? entry;
    const occurrences = countOccurrences(body, needle);
    if (occurrences === 0) continue;
    matchCount += occurrences;
    // Counting continues past the cap: the number is about the document, the
    // list is about what there is room to show.
    if (matches.length < PASSAGE_CAP) {
      matches.push({ excerpt: body, ...(parsed?.hash ? { blockHash: parsed.hash } : {}) });
    }
  }
  return matches.length > 0 ? { matches, matchCount } : null;
}

/** Non-overlapping occurrences of an already-lowercased needle. */
function countOccurrences(text: string, needle: string): number {
  const haystack = text.toLowerCase();
  let count = 0;
  let from = 0;
  for (;;) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) return count;
    count += 1;
    from = index + needle.length;
  }
}
