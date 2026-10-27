/**
 * `grep` matching: one compiled RE2 pattern that filters, counts and locates.
 *
 * RE2 syntax (ripgrep's dialect: no lookaround, no backreferences) run by
 * `re2js`, which never backtracks: V8's own `RegExp` took 20 s on `(a+)+$`
 * against 29 characters. Linear is not free, though: time grows with text length
 * times the compiled program's size, and a bounded repeat multiplies that
 * size, so repeat counts above {@link MAX_REPEAT} are refused here. The scan
 * adds the other bound, an abort signal it polls between lines. The unit of
 * matching is a line of the document's **grep text** (see `@meridian/agent-edit`'s
 * `grepText`): `^` and `$` anchor lines.
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
import { requiredLiterals } from "./required-literals.js";

/** How many passages one document contributes before the count speaks for the rest. */
export const PASSAGE_CAP = 3;

/** Largest bounded repeat (`x{n}`, `x{n,m}`) a pattern may use; see the module header. */
export const MAX_REPEAT = 100;

export interface GrepMatcher {
  /** Match spans in one line of grep text. */
  spans(line: string): Array<[start: number, end: number]>;
  /** Whether one line of grep text matches. */
  matchesLine(line: string): boolean;
  /**
   * Cheap whole-text prefilter: false only if no line can match. Present when a
   * case-insensitive pattern requires a literal. It only skips documents; every
   * hit is confirmed per line.
   */
  test?(text: string): boolean;
}

/** An escape (skipped, so `\{300}` is not a repeat) or a repeat count `{n}`, `{n,}`, `{n,m}`. */
const REPEAT = /\\.|\{(\d+)(?:,(\d*))?\}/gu;

function oversizedRepeat(pattern: string): number | undefined {
  for (const [, low, high] of pattern.matchAll(REPEAT)) {
    for (const bound of [low, high]) {
      if (bound && Number(bound) > MAX_REPEAT) return Number(bound);
    }
  }
  return undefined;
}

const REGEXP_SYNTAX = /[\\^$.*+?()[\]{}|]/gu;

/** Compile once per call, at the trust boundary; the error is the parser's message. */
export function compileGrep(pattern: string, ignoreCase: boolean): Result<GrepMatcher, string> {
  const repeat = oversizedRepeat(pattern);
  if (repeat !== undefined)
    return Err(`repeat count ${repeat} is above the limit of ${MAX_REPEAT}`);
  const flags = ignoreCase ? RE2JS.CASE_INSENSITIVE : 0;
  try {
    const line = RE2JS.compile(pattern, flags);
    // Without a literal, re2js loses its literal fast path under CASE_INSENSITIVE, so a
    // case-insensitive pattern prefilters with a V8 RegExp over the literal it requires.
    // An escaped literal cannot backtrack. `iu` folds case the way RE2 does.
    const literals = ignoreCase ? requiredLiterals(pattern) : undefined;
    const prefilter = literals
      ? new RegExp(
          literals.map((literal) => literal.replace(REGEXP_SYNTAX, "\\$&")).join("|"),
          "iu",
        )
      : undefined;
    return Ok({
      spans(text) {
        const spans: Array<[number, number]> = [];
        const matcher = line.matcher(text);
        while (matcher.find()) spans.push([matcher.start(), matcher.end()]);
        return spans;
      },
      matchesLine: (text) => line.matcher(text).find(),
      ...(prefilter ? { test: (text: string) => prefilter.test(text) } : {}),
    });
  } catch (cause) {
    return Err(cause instanceof Error ? cause.message : String(cause));
  }
}

/** One block of a document as the scan sees it. */
export interface GrepBlock {
  /** The block as `read` shows it, with no addressing prefix. */
  body: string;
  /** Hash of the block; absent for documents that carry no hashlines. */
  hash?: string;
  /** The block's markdown with link destinations spelled empty (`destinationFreeBlocks`). */
  destinationFree: string;
}

/** Where a passage's first match sits in its excerpt, so the window cuts there. */
export interface PassageAnchor {
  start: number;
  end: number;
}

/** One matched passage, as the model and the writer see it. */
export interface MatchedPassage {
  /** The matching block's text, with no addressing prefix on it. */
  excerpt: string;
  blockHash?: string;
  anchor?: PassageAnchor;
  /** The writer's text the first match covers: `excerpt` is markdown, which escapes it. */
  term?: string;
}

/** What one document contributed to a grep. */
export interface DocumentMatch {
  /** Matching passages in document order, at most {@link PASSAGE_CAP}. */
  matches: MatchedPassage[];
  /** Matches across the whole document (a line may match more than once). At least 1. */
  matchCount: number;
  /** Host-only: the block index each returned passage came from, aligned with `matches`. */
  blocks: number[];
}

/**
 * Collect the first passages of `blocks` the matcher hits and count every match. Null when none.
 * `pace` is awaited between lines, so the caller can yield or stop.
 */
export async function grepBlocks(
  blocks: readonly GrepBlock[],
  matcher: GrepMatcher,
  pace: () => Promise<void>,
): Promise<DocumentMatch | null> {
  const matches: MatchedPassage[] = [];
  const returned: number[] = [];
  let matchCount = 0;
  for (const [index, block] of blocks.entries()) {
    const view = markdownTextView(block.destinationFree);
    let first: [number, number] | undefined;
    let found = 0;
    let lineStart = 0;
    for (const line of view.text.split("\n")) {
      await pace();
      for (const span of matcher.spans(line)) {
        found += 1;
        first ??= [lineStart + span[0], lineStart + span[1]];
      }
      lineStart += line.length + 1;
    }
    if (!first) continue;
    matchCount += found;
    // Counting continues past the cap: the number is about the document, the
    // list is about what there is room to show.
    if (matches.length < PASSAGE_CAP) {
      const start = view.start[first[0]] ?? 0;
      const end = view.end[Math.max(first[1], first[0] + 1) - 1] ?? start;
      matches.push({
        excerpt: block.body,
        ...(block.hash ? { blockHash: block.hash } : {}),
        anchor: {
          start: toExcerptOffset(block.destinationFree, block.body, start),
          end: toExcerptOffset(block.destinationFree, block.body, end),
        },
        term: view.text.slice(first[0], first[1]),
      });
      returned.push(index);
    }
  }
  return matches.length > 0 ? { matches, matchCount, blocks: returned } : null;
}

/**
 * Where offset `at` of the destination-free markdown sits in the real body.
 * The two differ only by link and image destinations, which the first lacks:
 * where the real body has extra characters, it has them before the closing
 * delimiter the destination-free text is up to.
 */
function toExcerptOffset(destinationFree: string, body: string, at: number): number {
  if (destinationFree === body) return at;
  let i = 0;
  let j = 0;
  while (i < at && i < destinationFree.length && j < body.length) {
    if (destinationFree[i] !== body[j]) {
      const close = nextUnescaped(body, destinationFree[i] as string, j);
      if (close < 0) return Math.min(at, body.length);
      j = close;
    }
    i += 1;
    j += 1;
  }
  return j;
}

function nextUnescaped(text: string, char: string, from: number): number {
  for (let index = from; index < text.length; index += 1) {
    if (text[index] === "\\") index += 1;
    else if (text[index] === char) return index;
  }
  return -1;
}
