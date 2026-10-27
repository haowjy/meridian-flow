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
 * what it found with `exact: false` and `stopped: true`. It yields to the event loop and checks
 * the signal between lines; one line's match can't be interrupted, which the pattern's repeat
 * limit keeps short.
 */
import { grepText } from "@meridian/agent-edit";
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
  blocks: readonly GrepBlock[];
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
  /** False when documents that need a read went uncounted past the limit, or the scan stopped. */
  exact: boolean;
  /** True when the signal aborted the scan before the last document. */
  stopped: boolean;
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
  let stopped = false;
  let sliceStart = performance.now();
  const pace = async () => {
    if (performance.now() - sliceStart < YIELD_AFTER_MS) return;
    await new Promise((resolve) => setImmediate(resolve));
    sliceStart = performance.now();
    if (input.signal?.aborted) throw new ScanStopped();
  };
  /** Matches in the text; with `all` false it stops at the first, which is all a hit needs. */
  const countMatches = async (text: string, all: boolean) => {
    let count = 0;
    for (const line of text.split("\n")) {
      await pace();
      if (all) count += input.matcher.spans(line).length;
      else if (input.matcher.matchesLine(line)) return 1;
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
      // A document's read, once, with the grep text of each of its blocks.
      const loaded: { value?: { read: GrepRead<Shown>; texts: string[] } } = {};
      const load = async (): Promise<ScanOutcome<NonNullable<typeof loaded.value>, Fault>> => {
        if (loaded.value) return { ok: true, value: loaded.value };
        const result = await input.read(document.id);
        if (!result.ok) return result;
        loaded.value = {
          read: result.value,
          texts: result.value.blocks.map((block) => grepText([block.destinationFree])),
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
        text = result.value.texts.join("\n");
      }
      if (input.matcher.test && !input.matcher.test(text)) continue;
      const matchCount = await countMatches(text, !full && input.mode !== "files_with_matches");
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
      const { read, texts } = result.value;
      const match = await grepBlocks(read.blocks, texts, input.matcher, pace);
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
    if (!(cause instanceof ScanStopped)) throw cause;
    exact = false;
    stopped = true;
  }
  return { ok: true, value: { hits, totalFiles, exact, stopped } };
}
