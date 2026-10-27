/**
 * `grep` matching: one compiled RE2 pattern that filters, counts and locates.
 *
 * RE2 syntax (ripgrep's dialect: no lookaround, no backreferences) run by
 * `re2js`, which never backtracks: V8's own `RegExp` took 20 s on `(a+)+$`
 * against 29 characters. Linear is not free, though: time grows with text length
 * times the compiled program's size, and a bounded repeat multiplies that
 * size, so patterns whose compiled program passes {@link MAX_PROGRAM} are refused here. The scan
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
import type { GrepPassage } from "../ports/context-port.js";
import { requiredLiterals } from "./required-literals.js";

/** How many passages one document contributes before the count speaks for the rest. */
export const PASSAGE_CAP = 3;

/**
 * Largest compiled RE2 program a pattern may have. Matching time over a long line is the program's
 * size times the line's length, wherever the size comes from (`{n}`, longhand repeats, big classes,
 * nesting). Measured per 1M-character line with the program at 63 instructions: 2.6 s for 60 `\pL`
 * under `-i` (the slowest shape found), about 1.2 s for 60 `.`. `\d{4}-\d{2}-\d{2}` is 12.
 */
export const MAX_PROGRAM = 64;

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

const REGEXP_SYNTAX = /[\\^$.*+?()[\]{}|]/gu;

/** Compile once per call, at the trust boundary; the error is the parser's message. */
export function compileGrep(pattern: string, ignoreCase: boolean): Result<GrepMatcher, string> {
  const flags = ignoreCase ? RE2JS.CASE_INSENSITIVE : 0;
  try {
    const line = RE2JS.compile(pattern, flags);
    // `prog` is re2js internal (hence the exact version pin); a build that hides it refuses every pattern.
    const size = (line as unknown as { re2Input?: { prog?: { inst?: { length: number } } } })
      .re2Input?.prog?.inst?.length;
    if (size === undefined || size > MAX_PROGRAM) return Err("pattern is too complex");
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
  hash: string;
  /** The block's markdown with link destinations spelled empty (`destinationFreeBlocks`). */
  destinationFree: string;
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
 * The first {@link PASSAGE_CAP} blocks the matcher hits, as passages. `texts` holds each
 * block's grep text, aligned with `blocks`; `pace` is awaited between lines, so the caller can
 * yield or stop. The match count is not this function's: the caller already counted.
 */
export async function grepBlocks(
  blocks: readonly GrepBlock[],
  texts: readonly string[],
  matcher: GrepMatcher,
  locate: GrepLocate,
  pace: () => Promise<void>,
): Promise<DocumentMatch> {
  const matches: GrepPassage[] = [];
  const returned: number[] = [];
  for (const [index, block] of blocks.entries()) {
    if (matches.length === PASSAGE_CAP) break;
    let hit = false;
    for (const line of (texts[index] as string).split("\n")) {
      await pace();
      if (matcher.matchesLine(line)) {
        hit = true;
        break;
      }
    }
    if (!hit) continue;
    // Offsets into the plain text map back to the markdown only for blocks that are returned.
    const view = markdownTextView(block.destinationFree);
    let first: [number, number] = [0, 0];
    let lineStart = 0;
    for (const line of view.text.split("\n")) {
      const span = matcher.spans(line)[0];
      if (span) {
        first = [lineStart + span[0], lineStart + span[1]];
        break;
      }
      lineStart += line.length + 1;
    }
    const start = view.start[first[0]] ?? 0;
    const end = view.end[Math.max(first[1], first[0] + 1) - 1] ?? start;
    const anchor = locate(block, { start, end });
    matches.push({
      excerpt: block.body,
      ...(block.hash ? { blockHash: block.hash } : {}),
      ...(anchor ? { anchor } : {}),
      term: view.text.slice(first[0], first[1]),
    });
    returned.push(index);
  }
  return { matches, blocks: returned };
}
