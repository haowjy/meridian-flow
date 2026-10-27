/**
 * The scan behind `ContextFS.grep`: in path order, until `headLimit` files have matched.
 *
 * A document with usable stored grep text is matched from that text: a whole-text prefilter
 * skips it unread when no line can match, and every hit is confirmed line by line (a whole-text
 * match can cross a line break). Anything else, and any document whose passages are wanted, is
 * read through the effective hashline reader. Fast-path documents keep being counted past the
 * limit, which costs no reads; slow-path documents past the limit are not read, so the total
 * becomes a lower bound.
 */
import {
  type DocumentMatch,
  type GrepBlock,
  type GrepMatcher,
  grepBlocks,
} from "../../grep/matcher.js";
import type { GrepMode } from "../../ports/context-port.js";

/** Documents between yields to the event loop, so a long `-i` scan doesn't hold up requests. */
const YIELD_EVERY = 50;

/** A document read through the effective reader. */
export interface GrepRead<Shown> {
  blocks: GrepBlock[];
  revision: string | null;
  /** The host-only link facts of the passages `match` returned. */
  shownOf(match: DocumentMatch): Shown | undefined;
}

export interface ScanDocument {
  id: string;
  path: string;
}

export interface ScanHit<Shown> {
  document: ScanDocument;
  /** Null when the hit was answered from stored text without a read. */
  match: DocumentMatch | null;
  matchCount: number;
  revision: string | null;
  shown?: Shown;
}

export interface ScanResult<Shown> {
  hits: ScanHit<Shown>[];
  /** Files that matched, past the limit too. */
  totalFiles: number;
  /** False when documents that need a read went uncounted past the limit. */
  exact: boolean;
}

export type ScanOutcome<Value, Fault> = { ok: true; value: Value } | { ok: false; error: Fault };

export async function scanDocuments<Shown, Fault>(input: {
  documents: readonly ScanDocument[];
  /** Usable stored grep text by document id. */
  stored: ReadonlyMap<string, string>;
  matcher: GrepMatcher;
  mode: GrepMode;
  headLimit: number;
  read(documentId: string): Promise<ScanOutcome<GrepRead<Shown>, Fault>>;
}): Promise<ScanOutcome<ScanResult<Shown>, Fault>> {
  const hits: ScanHit<Shown>[] = [];
  let totalFiles = 0;
  let exact = true;
  let visited = 0;
  for (const document of input.documents) {
    if (++visited % YIELD_EVERY === 0) await new Promise((resolve) => setImmediate(resolve));
    const full = hits.length >= input.headLimit;
    const text = input.stored.get(document.id);
    if (text !== undefined) {
      if (input.matcher.test && !input.matcher.test(text)) continue;
      const matchCount = countMatches(text, input.matcher);
      if (matchCount === 0) continue;
      totalFiles += 1;
      if (full) continue;
      if (input.mode !== "content") {
        hits.push({ document, match: null, matchCount, revision: null });
        continue;
      }
    } else if (full) {
      // Counting it would take a read.
      exact = false;
      continue;
    }
    const read = await input.read(document.id);
    if (!read.ok) return read;
    const match = grepBlocks(read.value.blocks, input.matcher);
    if (!match) {
      if (text !== undefined) totalFiles -= 1;
      continue;
    }
    if (text === undefined) totalFiles += 1;
    const shown = input.mode === "content" ? read.value.shownOf(match) : undefined;
    hits.push({
      document,
      match,
      matchCount: match.matchCount,
      revision: read.value.revision,
      ...(shown ? { shown } : {}),
    });
  }
  return { ok: true, value: { hits, totalFiles, exact } };
}

function countMatches(text: string, matcher: GrepMatcher): number {
  let count = 0;
  for (const line of text.split("\n")) count += matcher.spans(line).length;
  return count;
}
