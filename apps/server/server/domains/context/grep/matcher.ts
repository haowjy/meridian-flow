/**
 * `grep` matching: one compiled RE2 pattern that filters, counts and locates.
 *
 * RE2 syntax (ripgrep's dialect: no lookaround, no backreferences) run by
 * `re2js`, which never backtracks: V8's own `RegExp` took 20 s on `(a+)+$`
 * against 29 characters. Linear is not free, though: time grows with text length
 * times the compiled program's size, and a bounded repeat multiplies that
 * size, so patterns whose repeat counts add up past {@link MAX_REPEAT} are refused here. The scan
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

/** Most a pattern's repeat counts may add up to (see {@link repeatWeight}). */
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

/**
 * What a pattern's repeats add up to: `x{n}` is n, `(?:x{n}){m}` is n·m, and repeats side by
 * side or in alternatives add (`[^z]{100}[^z]{100}` is 200): matching time over a long line
 * grows with that sum, and a chain of ten `{100}` took 19 s on a 1M-character line where one
 * takes 2 s. Read from the source, not RE2's parse, which `re2js` doesn't expose. Escapes and
 * character classes hold no repeats; `{n,m}` counts m, `{n,}` n.
 */
export function repeatWeight(pattern: string): number {
  // Per open group: the weight of its finished items, and of the item a quantifier may still scale.
  const frames = [{ total: 0, last: 0 }];
  const top = () => frames[frames.length - 1] as { total: number; last: number };
  const item = () => {
    const frame = top();
    frame.total += frame.last;
    frame.last = 0;
  };
  const chars = Array.from(pattern);
  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i];
    if (char === "\\") {
      item();
      const next = chars[i + 1];
      if (next === "Q") {
        const end = chars.indexOf("\\", i + 2);
        i = end < 0 ? chars.length : end + 1;
      } else if ((next === "p" || next === "P" || next === "x") && chars[i + 2] === "{") {
        i = Math.max(chars.indexOf("}", i + 2), i + 2);
      } else {
        i += 1;
      }
    } else if (char === "[") {
      item();
      let j = i + 1;
      if (chars[j] === "^") j += 1;
      if (chars[j] === "]") j += 1;
      while (j < chars.length && chars[j] !== "]") {
        if (chars[j] === "\\") j += 1;
        else if (chars[j] === "[" && chars[j + 1] === ":")
          j = Math.max(chars.indexOf("]", j + 2), j);
        j += 1;
      }
      i = j;
    } else if (char === "(") {
      item();
      frames.push({ total: 0, last: 0 });
      // `(?:`, `(?i:`, `(?P<name>`: the group's own syntax, up to its first `:` or `>`.
      if (chars[i + 1] === "?") {
        let j = i + 2;
        while (j < chars.length && !":>)".includes(chars[j] as string)) j += 1;
        i = chars[j] === ")" ? j - 1 : j;
      }
    } else if (char === ")" && frames.length > 1) {
      const group = frames.pop() as { total: number; last: number };
      top().last = group.total + group.last;
    } else if (char === "{") {
      const bound = /^\{(\d+)(?:,(\d*))?\}/u.exec(chars.slice(i, i + 24).join(""));
      if (!bound) {
        item();
        continue;
      }
      const frame = top();
      frame.last = Math.max(Number(bound[2] || bound[1]), 1) * Math.max(frame.last, 1);
      i += (bound[0] as string).length - 1;
    } else {
      item();
    }
  }
  const root = top();
  return root.total + root.last;
}

const REGEXP_SYNTAX = /[\\^$.*+?()[\]{}|]/gu;

/** Compile once per call, at the trust boundary; the error is the parser's message. */
export function compileGrep(pattern: string, ignoreCase: boolean): Result<GrepMatcher, string> {
  const repeat = repeatWeight(pattern);
  if (repeat > MAX_REPEAT)
    return Err(`repeat counts add up to ${repeat}, above the limit of ${MAX_REPEAT}`);
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
  hash: string;
  /** The block's markdown with link destinations spelled empty (`destinationFreeBlocks`). */
  destinationFree: string;
}

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
    let first: [number, number] | undefined;
    let lineStart = 0;
    for (const line of view.text.split("\n")) {
      first ??= matcher.spans(line)[0]?.map((at) => lineStart + at) as [number, number] | undefined;
      lineStart += line.length + 1;
    }
    if (!first) continue;
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
  return { matches, blocks: returned };
}

/**
 * Where offset `at` of the destination-free markdown sits in the real body.
 * The two differ only by link and image destinations, which the first lacks: where the
 * real body has a destination, the destination-free text is up to the character after it
 * (`)` or the space before a title).
 */
function toExcerptOffset(destinationFree: string, body: string, at: number): number {
  if (destinationFree === body) return at;
  let i = 0;
  let j = 0;
  while (i < at && i < destinationFree.length && j < body.length) {
    if (destinationFree[i] !== body[j]) j = endOfDestination(body, j);
    i += 1;
    j += 1;
  }
  return j;
}

/** Index just past the link destination starting at `from`: `<…>`, or bare with balanced parentheses. */
function endOfDestination(text: string, from: number): number {
  if (text[from] === "<") {
    for (let index = from + 1; index < text.length; index += 1) {
      if (text[index] === "\\") index += 1;
      else if (text[index] === ">") return index + 1;
    }
    return text.length;
  }
  let depth = 0;
  for (let index = from; index < text.length; index += 1) {
    const char = text[index] as string;
    if (char === "\\") index += 1;
    else if (/\s/u.test(char)) return index;
    else if (char === "(") depth += 1;
    else if (char === ")") {
      if (depth === 0) return index;
      depth -= 1;
    }
  }
  return text.length;
}
