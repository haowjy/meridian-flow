/**
 * The scan behind `ContextFS.grep`: in path order, until `headLimit` files have matched.
 *
 * Each document's grep text comes first: the stored text when the caller has a current one,
 * else the effective read's blocks. One loop over that text decides whether the document
 * matches and how often. A literal prefilter (for case-insensitive patterns) skips a document
 * unread when no line can match. Documents past the limit are only checked for a match, and
 * counted: that costs no read when stored text answers, so a document that needs a read is not
 * read, and the total becomes a lower bound. `content` mode reads the document to find passages.
 *
 * The scan stops when `signal` aborts (the caller left, or the time budget ran out) and returns
 * what it found with `exact: false` and `stopped: true`. Matching runs in worker threads that
 * the abort terminates mid-match, so the event loop stays free and a slow pattern ends on time.
 */
import {
  type DocumentMatch,
  type GrepBlock,
  type GrepLocate,
  type GrepMatcher,
  GrepStopped,
  grepBlocks,
} from "../../grep/matcher.js";
import type { GrepMode } from "../../ports/context-port.js";

/** Documents whose stored text is fetched, and held, together. */
const STORED_SLICE = 50;

/** A document read through the effective reader. */
export interface GrepRead<Shown> {
  blocks: readonly GrepBlock[];
  revision: string | null;
  /** Places a range of a block's destination-free markdown in its body. */
  locate: GrepLocate;
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
  /** False when documents that need a read went uncounted past the limit, or the scan stopped. */
  exact: boolean;
  /** True when the signal aborted the scan before the last document. */
  stopped: boolean;
}

export type ScanOutcome<Value, Fault> = { ok: true; value: Value } | { ok: false; error: Fault };

export async function scanDocuments<Shown, Fault>(input: {
  documents: readonly ScanDocument[];
  /** Usable stored grep text by document id, asked for one slice of documents at a time. */
  stored(ids: string[]): Promise<ReadonlyMap<string, string>>;
  matcher: GrepMatcher;
  mode: GrepMode;
  headLimit: number;
  signal: AbortSignal;
  read(documentId: string): Promise<ScanOutcome<GrepRead<Shown>, Fault>>;
}): Promise<ScanOutcome<ScanResult<Shown>, Fault>> {
  const hits: ScanHit<Shown>[] = [];
  let totalFiles = 0;
  let exact = true;
  let stopped = false;
  let stored: ReadonlyMap<string, string> = new Map();
  try {
    for (const [index, document] of input.documents.entries()) {
      if (input.signal.aborted) throw new GrepStopped();
      // Text for a slice at a time bounds what a scan holds, however many documents it covers.
      if (index % STORED_SLICE === 0)
        stored = await input.stored(
          input.documents.slice(index, index + STORED_SLICE).map(({ id }) => id),
        );
      const full = hits.length >= input.headLimit;
      // A document's read, once.
      const loaded: { value?: { read: GrepRead<Shown>; text: string } } = {};
      const load = async (): Promise<ScanOutcome<NonNullable<typeof loaded.value>, Fault>> => {
        if (loaded.value) return { ok: true, value: loaded.value };
        const result = await input.read(document.id);
        if (!result.ok) return result;
        loaded.value = {
          read: result.value,
          text: result.value.blocks.map((block) => block.text).join("\n"),
        };
        return { ok: true, value: loaded.value };
      };
      let text = stored.get(document.id);
      if (text === undefined) {
        if (full) {
          // Counting it would take a read.
          exact = false;
          continue;
        }
        const result = await load();
        if (!result.ok) return result;
        text = result.value.text;
      }
      if (input.matcher.test && !input.matcher.test(text)) continue;
      const matchCount = await input.matcher.count(
        text,
        !full && input.mode !== "files_with_matches",
        input.signal,
      );
      if (matchCount === 0) continue;
      totalFiles += 1;
      if (full) continue;
      if (input.mode !== "content") {
        hits.push({
          document,
          match: null,
          matchCount: input.mode === "count" ? matchCount : 0,
          revision: loaded.value?.read.revision ?? null,
        });
        continue;
      }
      const result = await load();
      if (!result.ok) return result;
      const { read } = result.value;
      const match = await grepBlocks(read.blocks, input.matcher, read.locate, input.signal);
      const shown = read.shownOf(match);
      hits.push({
        document,
        match,
        matchCount,
        revision: read.revision,
        ...(shown ? { shown } : {}),
      });
    }
  } catch (cause) {
    if (!(cause instanceof GrepStopped)) throw cause;
    exact = false;
    stopped = true;
  }
  return { ok: true, value: { hits, totalFiles, exact, stopped } };
}
