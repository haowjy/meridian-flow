import { markdownTextView } from "@meridian/agent-edit";
import { RE2JS } from "re2js";
import { Err, Ok, type Result } from "../../../shared/result.js";
import type { GrepPassage } from "../ports/context-port.js";
import { runMatch } from "./match-pool.js";
import type { Passage } from "./match-worker.js";
import { requiredLiterals } from "./required-literals.js";

export { GrepStopped } from "./match-pool.js";

const PASSAGE_CAP = 3;

export interface GrepMatcher {
  count(text: string, all: boolean, signal: AbortSignal): Promise<number>;
  passages(texts: readonly string[], limit: number, signal: AbortSignal): Promise<Passage[]>;
  /**
   * Cheap whole-text prefilter: false only if no line can match. Present when a
   * case-insensitive pattern requires a literal. It only skips documents; every
   * hit is confirmed by the worker.
   */
  test?(text: string): boolean;
}

const REGEXP_SYNTAX = /[\\^$.*+?()[\]{}|]/gu;

export function compileGrep(pattern: string, ignoreCase: boolean): Result<GrepMatcher, string> {
  try {
    RE2JS.compile(pattern, ignoreCase ? RE2JS.CASE_INSENSITIVE : 0);
  } catch (cause) {
    return Err(cause instanceof Error ? cause.message : String(cause));
  }
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

export interface GrepBlock {
  body: string;
  hash: string;
  destinationFree: string;
  text: string;
  verbatim: boolean;
}

export type GrepLocate = (
  block: Pick<GrepBlock, "body" | "destinationFree">,
  range: { start: number; end: number },
) => { start: number; end: number } | null;

export interface DocumentMatch {
  matches: GrepPassage[];
  blocks: number[];
}

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
  const matches = found.map(([index, from, to]): GrepPassage => {
    const block = blocks[index] as GrepBlock;
    const hash = block.hash ? { blockHash: block.hash } : {};
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
