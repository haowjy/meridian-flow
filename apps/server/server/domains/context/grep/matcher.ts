/**
 * `grep` matching: one RE2 pattern that filters, counts and locates.
 *
 * RE2 syntax (ripgrep's dialect: no lookaround, no backreferences) run by
 * `re2js`, which never backtracks: V8's own `RegExp` took 20 s on `(a+)+$`
 * against 29 characters. Linear is not free, though: time grows with text length
 * times the compiled program's size, and one `re2js` call can't be interrupted. So the
 * matching runs in a worker thread (`match-pool.ts`) that the caller's abort signal
 * terminates, and no static limit on the pattern is needed beyond RE2's own refusals
 * and the pattern's length. The unit of matching is a line of the document's **grep
 * text** (see `@meridian/agent-edit`'s `grepBlockText`): `^` and `$` anchor lines.
 *
 * **A document reports several passages, not one.** The list is capped because
 * a result is a way in, not the document itself; the count beside it stays
 * honest about everything the cap left out. The hash leaves through its own
 * field, never inside the excerpt, so nothing downstream has to know the
 * hashline format to show a sentence to a writer.
 */
import { markdownTextView } from "@meridian/agent-edit";
import { RE2JS } from "re2js";
import { Err, Ok, type Result } from "../../../shared/result.js";
import type { GrepPassage } from "../ports/context-port.js";
import { runMatch } from "./match-pool.js";
import type { Passage } from "./match-worker.js";
import { requiredLiterals } from "./required-literals.js";

export { GrepStopped } from "./match-pool.js";

/** How many passages one document contributes before the count speaks for the rest. */
const PASSAGE_CAP = 3;

/**
 * A compiled pattern. Matching methods run off the event loop and reject with `GrepStopped` when
 * `signal` aborts; the work in flight is then abandoned, never finished.
 */
export interface GrepMatcher {
  /** Matches in `text`; with `all` false, 1 at the first matching line or 0. */
  count(text: string, all: boolean, signal: AbortSignal): Promise<number>;
  /**
   * The first `limit` texts that have a matching line, each with its first match as offsets
   * into that text.
   */
  passages(texts: readonly string[], limit: number, signal: AbortSignal): Promise<Passage[]>;
  /**
   * Cheap whole-text prefilter: false only if no line can match. Present when a
   * case-insensitive pattern requires a literal. It only skips documents; every
   * hit is confirmed by the worker.
   */
  test?(text: string): boolean;
}

const REGEXP_SYNTAX = /[\\^$.*+?()[\]{}|]/gu;

/**
 * Checks the pattern at the trust boundary (the error is the parser's message). The worker
 * compiles it again, once per thread, and caches it.
 */
export function compileGrep(pattern: string, ignoreCase: boolean): Result<GrepMatcher, string> {
  try {
    RE2JS.compile(pattern, ignoreCase ? RE2JS.CASE_INSENSITIVE : 0);
  } catch (cause) {
    return Err(cause instanceof Error ? cause.message : String(cause));
  }
  // Without a literal, re2js loses its literal fast path under CASE_INSENSITIVE, so a
  // case-insensitive pattern prefilters with a V8 RegExp over the literal it requires.
  // An escaped literal cannot backtrack. `iu` folds case the way RE2 does.
  const literals = ignoreCase ? requiredLiterals(pattern) : undefined;
  const prefilter = literals
    ? new RegExp(literals.map((literal) => literal.replace(REGEXP_SYNTAX, "\\$&")).join("|"), "iu")
    : undefined;
  return Ok({
    count: (text, all, signal) => runMatch({ op: "count", pattern, ignoreCase, text, all }, signal),
    passages: (texts, limit, signal) =>
      runMatch({ op: "passages", pattern, ignoreCase, texts, limit }, signal),
    ...(prefilter ? { test: (text: string) => prefilter.test(text) } : {}),
  });
}

/** One block of a document as the scan sees it. */
export interface GrepBlock {
  /** The block as `read` shows it, with no addressing prefix. */
  body: string;
  hash: string;
  /** The block's markdown with link destinations spelled empty (`destinationFreeBlocks`). */
  destinationFree: string;
  /** What the matcher reads: `grepBlockText` of `destinationFree`, or a code file's text. */
  text: string;
  /** A code file's block: its text is no decoding of `destinationFree`, and has no body anchor. */
  verbatim: boolean;
}

/** Places a range of a block's `destinationFree` markdown in its `body`; null when it can't. */
export type GrepLocate = (
  block: Pick<GrepBlock, "body" | "destinationFree">,
  range: { start: number; end: number },
) => { start: number; end: number } | null;

/** What one document contributed to a content-mode grep. */
export interface DocumentMatch {
  /** Matching passages in document order, at most {@link PASSAGE_CAP}. */
  matches: GrepPassage[];
  /** Host-only: the block index each returned passage came from, aligned with `matches`. */
  blocks: number[];
}

/**
 * The first {@link PASSAGE_CAP} blocks the matcher hits, as passages. The match count is not
 * this function's: the caller already counted.
 */
export async function grepBlocks(
  blocks: readonly GrepBlock[],
  matcher: GrepMatcher,
  locate: GrepLocate,
  signal: AbortSignal,
): Promise<DocumentMatch> {
  const found = await matcher.passages(
    blocks.map((block) => block.text),
    PASSAGE_CAP,
    signal,
  );
  // Offsets into the plain text map back to the markdown only for blocks that are returned.
  const matches = found.map(([index, from, to]): GrepPassage => {
    const block = blocks[index] as GrepBlock;
    const hash = block.hash ? { blockHash: block.hash } : {};
    // A code file's text is the file as stored: offsets are text offsets, and there is no anchor.
    if (block.verbatim) return { excerpt: block.body, ...hash, term: block.text.slice(from, to) };
    const view = markdownTextView(block.destinationFree);
    const start = view.start[from] ?? 0;
    const end = view.end[Math.max(to, from + 1) - 1] ?? start;
    const anchor = locate(block, { start, end });
    return {
      excerpt: block.body,
      ...hash,
      ...(anchor ? { anchor } : {}),
      term: view.text.slice(from, to),
    };
  });
  return { matches, blocks: found.map(([index]) => index) };
}
