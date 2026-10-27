/**
 * The scan behind `ContextFS.grep`: in path order, until `headLimit` files have matched.
 *
 * A document with usable stored grep text is matched from that text: a literal prefilter (for
 * case-insensitive patterns) skips it unread when no line can match, and every hit is confirmed
 * line by line. Anything else, and any document whose passages are wanted, is
 * read through the effective hashline reader. Fast-path documents keep being counted past the
 * limit, which costs no reads; slow-path documents past the limit are not read, so the total
 * becomes a lower bound. Past the limit a document is only checked for a match, and the matches
 * are counted only for `count` mode: `content` mode takes its count from the read.
 *
 * The scan stops when `signal` aborts (the caller left, or the time budget ran out) and returns
 * what it found with `exact: false`. It yields to the event loop and checks the signal between
 * lines; one line's match can't be interrupted, which the pattern's repeat limit keeps short.
 */
import {
  type DocumentMatch,
  type GrepBlock,
  type GrepMatcher,
  grepBlocks,
} from "../../grep/matcher.js";
import type { GrepMode } from "../../ports/context-port.js";

/**
 * Milliseconds of matching between yields to the event loop, so a long scan doesn't hold up
 * requests. A request takes many turns of the loop, so a slice that long is added to each of
 * them: it is time, not a document count, and it is checked between lines, not documents.
 */
const YIELD_AFTER_MS = 10;

/** Documents whose stored text is fetched, and held, together. */
const STORED_SLICE = 50;

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

/** Thrown by the pacer when the signal aborts, to unwind to the scan's return. */
class ScanStopped extends Error {}

export async function scanDocuments<Shown, Fault>(input: {
  documents: readonly ScanDocument[];
  /** Usable stored grep text by document id, asked for one slice of documents at a time. */
  stored(ids: string[]): Promise<ReadonlyMap<string, string>>;
  matcher: GrepMatcher;
  mode: GrepMode;
  headLimit: number;
  signal?: AbortSignal;
  read(documentId: string): Promise<ScanOutcome<GrepRead<Shown>, Fault>>;
}): Promise<ScanOutcome<ScanResult<Shown>, Fault>> {
  const hits: ScanHit<Shown>[] = [];
  let totalFiles = 0;
  let exact = true;
  let sliceStart = performance.now();
  const pace = async () => {
    if (performance.now() - sliceStart < YIELD_AFTER_MS) return;
    await new Promise((resolve) => setImmediate(resolve));
    sliceStart = performance.now();
    if (input.signal?.aborted) throw new ScanStopped();
  };
  const hasMatch = async (text: string) => {
    for (const line of text.split("\n")) {
      await pace();
      if (input.matcher.matchesLine(line)) return true;
    }
    return false;
  };
  const countMatches = async (text: string) => {
    let count = 0;
    for (const line of text.split("\n")) {
      await pace();
      count += input.matcher.spans(line).length;
    }
    return count;
  };
  let stored: ReadonlyMap<string, string> = new Map();
  try {
    for (const [index, document] of input.documents.entries()) {
      if (input.signal?.aborted) throw new ScanStopped();
      // Text for a slice at a time bounds what a scan holds, however many documents it covers.
      if (index % STORED_SLICE === 0)
        stored = await input.stored(
          input.documents.slice(index, index + STORED_SLICE).map(({ id }) => id),
        );
      const full = hits.length >= input.headLimit;
      const text = stored.get(document.id);
      if (text !== undefined) {
        if (input.matcher.test && !input.matcher.test(text)) continue;
        if (!(await hasMatch(text))) continue;
        totalFiles += 1;
        if (full) continue;
        if (input.mode !== "content") {
          const matchCount = input.mode === "count" ? await countMatches(text) : 0;
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
      const match = await grepBlocks(read.value.blocks, input.matcher, pace);
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
  } catch (cause) {
    if (!(cause instanceof ScanStopped)) throw cause;
    exact = false;
  }
  return { ok: true, value: { hits, totalFiles, exact } };
}
