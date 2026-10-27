/**
 * `grep` matching: one compiled RE2 pattern that filters, counts and locates.
 *
 * RE2 syntax (ripgrep's dialect: no lookaround, no backreferences) run by
 * `re2js` in linear time, so no pattern can stall the event loop; V8's own
 * `RegExp` took 20 s on `(a+)+$` against 29 characters. The unit of matching is
 * a line of the document's **grep text** (see `@meridian/agent-edit`'s
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

/** How many passages one document contributes before the count speaks for the rest. */
export const PASSAGE_CAP = 3;

export interface GrepMatcher {
  /** Match spans in one line of grep text. */
  spans(line: string): Array<[start: number, end: number]>;
  /**
   * Whole-text prefilter in multiline mode: false only if no line can match.
   * Absent when the pattern has `\A`, `\z` or a flag group, whose meaning
   * changes on whole text. It only skips documents; every hit is confirmed per line.
   */
  test?(text: string): boolean;
}

/** `\A`, `\z`, or a flag group such as `(?i)`, `(?-m)` or `(?s:`. Lexical and conservative. */
const WHOLE_TEXT_SENSITIVE = /\\[Az]|\(\?(?!:|P?<[A-Za-z_])/u;

/** Compile once per call, at the trust boundary; the error is the parser's message. */
export function compileGrep(pattern: string, ignoreCase: boolean): Result<GrepMatcher, string> {
  const flags = ignoreCase ? RE2JS.CASE_INSENSITIVE : 0;
  try {
    const line = RE2JS.compile(pattern, flags);
    const whole = WHOLE_TEXT_SENSITIVE.test(pattern)
      ? undefined
      : RE2JS.compile(pattern, flags | RE2JS.MULTILINE);
    return Ok({
      spans(text) {
        const spans: Array<[number, number]> = [];
        const matcher = line.matcher(text);
        while (matcher.find()) spans.push([matcher.start(), matcher.end()]);
        return spans;
      },
      ...(whole ? { test: (text: string) => whole.matcher(text).find() } : {}),
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

/** Collect the first passages of `blocks` the matcher hits and count every match. Null when none. */
export function grepBlocks(
  blocks: readonly GrepBlock[],
  matcher: GrepMatcher,
): DocumentMatch | null {
  const matches: MatchedPassage[] = [];
  const returned: number[] = [];
  let matchCount = 0;
  for (const [index, block] of blocks.entries()) {
    const view = markdownTextView(block.destinationFree);
    let first: [number, number] | undefined;
    let found = 0;
    let lineStart = 0;
    for (const line of view.text.split("\n")) {
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
